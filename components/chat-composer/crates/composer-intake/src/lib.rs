//! 文件准入（intake）纯组件：文件选择器、粘贴、拖放三个入口统一走这一份检查。
//! 语义移植自 archive/ts/intake.ts（对齐 DSH InputBar.intakeFiles 的「共享准入」）。
//!
//! 整批 vs 逐文件的语义（镜像 DSH 并写明取舍）：
//! - `max_files` / `max_bytes_total` 违规 → 整批拒绝（在添加任何东西之前，绝不留下
//!   「加了一半」的中间状态）；
//! - `max_bytes_per_file` 违规 → 只拒绝该文件（DSH 对通用文件本就没有本地大小上限；
//!   推广到通用文件时选择逐文件拒绝，避免超大文件连坐同批正常文件）；
//! - 类型不允许 → 只拒绝该文件；拖入目录由平台侧识别后按 unsupported_type 报告。
//!
//! [`IntakeDecision::accepted`] 是**输入数组的下标**：与「accepted 里的对象就是传入
//! FileMeta 本体」的 TS 契约等价——调用方按索引取回原始条目，身份不重建。

/// 一个待准入文件的元数据。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileMeta {
    pub name: String,
    pub media_type: String,
    pub bytes: u64,
}

/// 统一准入策略（缺省 = 不限制）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IntakePolicy {
    /// 草稿最多同时持有的文件数（含已有附件）；超限拒绝整批。
    pub max_files: Option<u64>,
    /// 单个文件的最大字节数；超限只拒绝该文件。
    pub max_bytes_per_file: Option<u64>,
    /// 草稿附件总字节数上限（含已有附件）；超限拒绝整批。
    pub max_bytes_total: Option<u64>,
    /// 允许的媒体类型（精确匹配，忽略大小写与首尾空白）。
    pub allowed_media_types: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RejectionReason {
    TooMany,
    FileTooLarge,
    TotalTooLarge,
    UnsupportedType,
}

impl RejectionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RejectionReason::TooMany => "too_many",
            RejectionReason::FileTooLarge => "file_too_large",
            RejectionReason::TotalTooLarge => "total_too_large",
            RejectionReason::UnsupportedType => "unsupported_type",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntakeRejection {
    pub name: String,
    pub reason: RejectionReason,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntakeDecision {
    /// 被接受的条目，以输入 `files` 的下标表示（调用方据此取回原始条目，身份不重建）。
    pub accepted: Vec<usize>,
    pub rejected: Vec<IntakeRejection>,
}

fn normalize_type(media_type: &str) -> String {
    media_type.trim().to_lowercase()
}

/// 一批文件的统一准入。检查顺序：
/// 1) max_files（整批）→ 2) 类型（逐文件）→ 3) max_bytes_per_file（逐文件）
/// → 4) max_bytes_total（整批，只统计将通过准入的字节：已被逐文件拒绝的文件
///    本来就不会添加，它们的字节不应连坐剩下的文件）。
pub fn intake_files(
    files: &[FileMeta],
    policy: &IntakePolicy,
    current_assets: &[FileMeta],
) -> IntakeDecision {
    // 1) 数量上限：超限整批拒绝，先于任何添加（DSH 同款）。
    if let Some(max_files) = policy.max_files {
        if current_assets.len() as u64 + files.len() as u64 > max_files {
            return IntakeDecision {
                accepted: Vec::new(),
                rejected: files
                    .iter()
                    .map(|file| IntakeRejection {
                        name: file.name.clone(),
                        reason: RejectionReason::TooMany,
                    })
                    .collect(),
            };
        }
    }
    let mut reasons: Vec<Option<RejectionReason>> = vec![None; files.len()];
    let mut survivors: Vec<usize> = Vec::new();
    for (index, file) in files.iter().enumerate() {
        // 2) 类型：只拒绝该文件。
        if let Some(allowed) = &policy.allowed_media_types {
            let matches = allowed
                .iter()
                .any(|candidate| normalize_type(candidate) == normalize_type(&file.media_type));
            if !matches {
                reasons[index] = Some(RejectionReason::UnsupportedType);
                continue;
            }
        }
        // 3) 单文件大小：只拒绝该文件（见模块头的取舍说明）。
        if let Some(max_bytes_per_file) = policy.max_bytes_per_file {
            if file.bytes > max_bytes_per_file {
                reasons[index] = Some(RejectionReason::FileTooLarge);
                continue;
            }
        }
        survivors.push(index);
    }
    // 4) 总量上限：超限整批拒绝；已被逐文件拒绝的保留原原因。
    if let Some(max_bytes_total) = policy.max_bytes_total {
        let incoming: u64 = survivors.iter().map(|&index| files[index].bytes).sum();
        let existing: u64 = current_assets.iter().map(|file| file.bytes).sum();
        if existing + incoming > max_bytes_total {
            survivors.clear();
            for (index, file) in files.iter().enumerate() {
                if reasons[index].is_none() {
                    reasons[index] = Some(RejectionReason::TotalTooLarge);
                }
                let _ = file;
            }
        }
    }
    IntakeDecision {
        rejected: files
            .iter()
            .zip(&reasons)
            .filter_map(|(file, reason)| {
                reason.map(|reason| IntakeRejection {
                    name: file.name.clone(),
                    reason,
                })
            })
            .collect(),
        accepted: survivors,
    }
}

/// 粘贴路由的判定输入条目：kind 为 "file" / "string"，mime 为条目的类型字符串。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClipboardItem {
    pub kind: String,
    pub mime: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct ClipboardSplit {
    pub has_files: bool,
    pub has_text: bool,
}

/// 粘贴路由判定（DSH PASTE_COMMAND 的同款拆分）：文本以 kind === "string" 且
/// mime === "text/plain" 为准——消费纯文本而不是 HTML。文件与文本可以同时为真。
pub fn split_clipboard(items: &[ClipboardItem]) -> ClipboardSplit {
    let mut split = ClipboardSplit::default();
    for item in items {
        if item.kind == "file" {
            split.has_files = true;
        } else if item.kind == "string" && item.mime == "text/plain" {
            split.has_text = true;
        }
    }
    split
}

const BYTE_UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];

/// 人类可读的字节数（1024 进制，≥1KB 保留一位小数并省略 .0）。
/// 负数返回空串——对齐 TS 版对非有限/负数的守卫。
pub fn format_bytes(bytes: i64) -> String {
    if bytes < 0 {
        return String::new();
    }
    let mut value = bytes as f64;
    let mut unit = 0usize;
    while value >= 1024.0 && unit < BYTE_UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    let text = if unit == 0 {
        format!("{}", value.round() as i64)
    } else {
        // 与 Math.round(value * 10) / 10 的显示一致：一位小数，.0 省略。
        let tenths = (value * 10.0).round() as i64;
        if tenths % 10 == 0 {
            format!("{}", tenths / 10)
        } else {
            format!("{}.{}", tenths / 10, tenths % 10)
        }
    };
    format!("{} {}", text, BYTE_UNITS[unit])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(name: &str, media_type: &str, bytes: u64) -> FileMeta {
        FileMeta {
            name: name.into(),
            media_type: media_type.into(),
            bytes,
        }
    }

    fn no_policy() -> IntakePolicy {
        IntakePolicy::default()
    }

    /// IT01：无策略时全部接受，且 accepted 是输入下标（身份可回取）。
    #[test]
    fn it01_no_policy_accepts_everything_and_keeps_indices() {
        let files = vec![
            meta("a.txt", "text/plain", 3),
            meta("b.png", "image/png", 9),
        ];
        let decision = intake_files(&files, &no_policy(), &[]);
        assert_eq!(decision.accepted, vec![0, 1]);
        assert_eq!(decision.rejected.len(), 0);
        assert_eq!(
            files[decision.accepted[0]].name, "a.txt",
            "按索引取回原条目"
        );
    }

    /// IT02：maxFiles 按 existing+incoming 计算，违规时在任何添加之前整批拒绝。
    #[test]
    fn it02_max_files_counts_existing_plus_incoming_and_rejects_whole_batch() {
        let files = vec![meta("a", "text/plain", 1), meta("b", "text/plain", 1)];
        let existing = vec![meta("old", "text/plain", 1)];
        let policy = IntakePolicy {
            max_files: Some(2),
            ..Default::default()
        };
        let decision = intake_files(&files, &policy, &existing);
        assert!(decision.accepted.is_empty());
        assert_eq!(decision.rejected.len(), 2);
        assert!(decision
            .rejected
            .iter()
            .all(|item| item.reason == RejectionReason::TooMany));
    }

    /// IT03：maxBytesPerFile 只拒绝超大的那个，同批其余照常进入。
    #[test]
    fn it03_max_bytes_per_file_rejects_only_the_oversized_file() {
        let files = vec![
            meta("small", "text/plain", 10),
            meta("big", "text/plain", 100),
            meta("ok", "text/plain", 20),
        ];
        let policy = IntakePolicy {
            max_bytes_per_file: Some(50),
            ..Default::default()
        };
        let decision = intake_files(&files, &policy, &[]);
        assert_eq!(decision.accepted, vec![0, 2]);
        assert_eq!(decision.rejected.len(), 1);
        assert_eq!(decision.rejected[0].name, "big");
        assert_eq!(decision.rejected[0].reason, RejectionReason::FileTooLarge);
    }

    /// IT04：maxBytesTotal 把已有附件计入，超限整批拒绝。
    #[test]
    fn it04_max_bytes_total_counts_existing_assets_and_rejects_batch() {
        let files = vec![meta("a", "text/plain", 60), meta("b", "text/plain", 60)];
        let existing = vec![meta("old", "text/plain", 50)];
        let policy = IntakePolicy {
            max_bytes_total: Some(150),
            ..Default::default()
        };
        let decision = intake_files(&files, &policy, &existing);
        assert!(decision.accepted.is_empty());
        assert!(decision
            .rejected
            .iter()
            .all(|item| item.reason == RejectionReason::TotalTooLarge));
    }

    /// IT05：allowedMediaTypes 精确匹配（忽略大小写与空白）；缺省 = 不限。
    #[test]
    fn it05_allowed_media_types_match_exactly_with_normalization() {
        let files = vec![meta("a", " image/png ", 1), meta("b", "text/plain", 1)];
        let policy = IntakePolicy {
            allowed_media_types: Some(vec!["IMAGE/PNG".into()]),
            ..Default::default()
        };
        let decision = intake_files(&files, &policy, &[]);
        assert_eq!(decision.accepted, vec![0]);
        assert_eq!(
            decision.rejected[0].reason,
            RejectionReason::UnsupportedType
        );
        let decision = intake_files(&files, &no_policy(), &[]);
        assert_eq!(decision.accepted, vec![0, 1]);
    }

    /// IT06：unsupported_type 与逐文件大小各有各的原因；总量拒绝不覆盖已有原因。
    #[test]
    fn it06_rejections_keep_their_own_reasons_when_total_rejects_the_rest() {
        let files = vec![
            meta("bad-type", "video/x", 10),
            meta("too-big", "text/plain", 999),
            meta("fine", "text/plain", 10),
        ];
        let policy = IntakePolicy {
            max_bytes_per_file: Some(100),
            max_bytes_total: Some(5),
            allowed_media_types: Some(vec!["text/plain".into()]),
            ..Default::default()
        };
        let decision = intake_files(&files, &policy, &[]);
        assert!(decision.accepted.is_empty());
        assert_eq!(
            decision
                .rejected
                .iter()
                .find(|item| item.name == "bad-type")
                .unwrap()
                .reason,
            RejectionReason::UnsupportedType
        );
        assert_eq!(
            decision
                .rejected
                .iter()
                .find(|item| item.name == "too-big")
                .unwrap()
                .reason,
            RejectionReason::FileTooLarge
        );
        assert_eq!(
            decision
                .rejected
                .iter()
                .find(|item| item.name == "fine")
                .unwrap()
                .reason,
            RejectionReason::TotalTooLarge
        );
    }

    /// IT07：splitClipboard 与 DSH 粘贴路由输入同构；文件与文本可同时为真。
    #[test]
    fn it07_split_clipboard_mirrors_the_paste_routing_input() {
        let items = vec![
            ClipboardItem {
                kind: "string".into(),
                mime: "text/html".into(),
            },
            ClipboardItem {
                kind: "file".into(),
                mime: "image/png".into(),
            },
            ClipboardItem {
                kind: "string".into(),
                mime: "text/plain".into(),
            },
        ];
        let split = split_clipboard(&items);
        assert!(split.has_files);
        assert!(split.has_text);
        let text_only = split_clipboard(&[ClipboardItem {
            kind: "string".into(),
            mime: "text/plain".into(),
        }]);
        assert!(!text_only.has_files);
        assert!(text_only.has_text);
    }

    /// IT08：formatBytes 1024 进制，≥1KB 一位小数并省略 .0；负数返回空串。
    #[test]
    fn it08_format_bytes_renders_1024_based_sizes() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1 KB");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(1048576), "1 MB");
        assert_eq!(format_bytes(-1), "");
    }
}
