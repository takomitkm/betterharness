// 文件准入（intake）纯模块：文件选择器、粘贴、拖放三个入口统一走这一份检查，
// 语义对齐 DSH InputBar.intakeFiles 的「共享准入」。零依赖：不许 import react/lexical，
// Deno/Node 均可直接运行（verify/intake.test.ts）。
//
// 整批 vs 逐文件的语义（镜像 DSH 并写明取舍）：
//   - maxFiles / maxBytesTotal 违规 → 整批拒绝（DSH：existing+incoming 的数量与总量违规
//     在往 rail 添加任何东西之前拒绝整批，绝不留下「加了一半」的中间状态）；
//   - maxBytesPerFile 违规 → 只拒绝该文件。DSH 的单张图片大小违规虽然也整批拒绝，
//     但 DSH 对通用文件本就没有本地大小上限；把上限推广到通用文件时这里选择逐文件拒绝，
//     否则一个超大文件会连坐吞掉同批正常文件（与浏览器测试 B27 的验收标准一致）；
//   - 类型不允许 → 只拒绝该文件（unsupported_type）。拖入的目录也归入这一原因：
//     由浏览器侧用 webkitGetAsEntry 识别后标注 directory，本模块不感知目录。
//
// accepted 里的对象就是传入的 FileMeta 本体（不复制、不重建），宿主可据此找回原始 File/Blob。

export interface FileMeta {
  name: string;
  mediaType: string;
  bytes: number;
}

export interface IntakePolicy {
  /** 草稿最多同时持有的文件数（含已有附件）；超限拒绝整批。缺省 = 不限。 */
  maxFiles?: number;
  /** 单个文件的最大字节数；超限只拒绝该文件。缺省 = 不限。 */
  maxBytesPerFile?: number;
  /** 草稿附件总字节数上限（含已有附件）；超限拒绝整批。缺省 = 不限。 */
  maxBytesTotal?: number;
  /** 允许的媒体类型（精确匹配，忽略大小写与首尾空白）；缺省 = 不限。 */
  allowedMediaTypes?: string[];
}

export type IntakeRejectionReason = "too_many" | "file_too_large" | "total_too_large" | "unsupported_type";

export interface IntakeRejection {
  name: string;
  reason: IntakeRejectionReason;
}

export interface IntakeDecision {
  accepted: FileMeta[];
  rejected: IntakeRejection[];
}

const normalizeType = (mediaType: string): string => mediaType.trim().toLowerCase();

/**
 * 一批文件的统一准入。检查顺序：
 *   1) maxFiles（整批）→ 2) 类型（逐文件）→ 3) maxBytesPerFile（逐文件）
 *   → 4) maxBytesTotal（整批，只统计将通过准入的字节：已被逐文件拒绝的文件
 *      本来就不会添加，它们的字节不应连坐剩下的文件）。
 * currentAssets 是草稿里已有附件的元数据：数量与总量上限都按 existing + incoming 计算。
 */
export function intakeFiles(files: readonly FileMeta[], policy: IntakePolicy, currentAssets: readonly FileMeta[]): IntakeDecision {
  // 1) 数量上限：超限整批拒绝，先于任何添加（DSH 同款）。
  if (policy.maxFiles !== undefined && currentAssets.length + files.length > policy.maxFiles) {
    return { accepted: [], rejected: files.map((file) => ({ name: file.name, reason: "too_many" })) };
  }
  const reasons = new Map<FileMeta, IntakeRejectionReason>();
  const survivors: FileMeta[] = [];
  for (const file of files) {
    // 2) 类型：只拒绝该文件。
    if (policy.allowedMediaTypes && !policy.allowedMediaTypes.some((allowed) => normalizeType(allowed) === normalizeType(file.mediaType))) {
      reasons.set(file, "unsupported_type");
      continue;
    }
    // 3) 单文件大小：只拒绝该文件（见模块头的取舍说明）。
    if (policy.maxBytesPerFile !== undefined && file.bytes > policy.maxBytesPerFile) {
      reasons.set(file, "file_too_large");
      continue;
    }
    survivors.push(file);
  }
  // 4) 总量上限：超限整批拒绝；已被逐文件拒绝的保留原原因。
  if (policy.maxBytesTotal !== undefined) {
    const incoming = survivors.reduce((sum, file) => sum + file.bytes, 0);
    const existing = currentAssets.reduce((sum, file) => sum + file.bytes, 0);
    if (existing + incoming > policy.maxBytesTotal) {
      survivors.length = 0;
      for (const file of files) if (!reasons.has(file)) reasons.set(file, "total_too_large");
    }
  }
  return {
    accepted: survivors,
    rejected: files.filter((file) => reasons.has(file)).map((file) => ({ name: file.name, reason: reasons.get(file)! })),
  };
}

export interface ClipboardSplit {
  hasFiles: boolean;
  hasText: boolean;
}

/**
 * 粘贴路由的判定输入（DSH PASTE_COMMAND 的同款拆分）：剪贴板 items 里有没有文件、
 * 有没有纯文本。文本以 kind === "string" 且 type === "text/plain" 为准——DSH 消费纯文本
 * 而不是 HTML，其余字符串类型（text/html 等）不算。文件与文本可以同时为真：
 * 一次粘贴两者都处理（文件先准入，text/plain 原文随后插入）。
 */
export function splitClipboard(items: readonly { kind: string; type: string }[]): ClipboardSplit {
  let hasFiles = false;
  let hasText = false;
  for (const item of items) {
    if (item.kind === "file") hasFiles = true;
    else if (item.kind === "string" && item.type === "text/plain") hasText = true;
  }
  return { hasFiles, hasText };
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** 人类可读的字节数（1024 进制，≥1KB 保留一位小数并省略 .0）。供卡片与拖放遮罩的限额文案使用。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = unit === 0 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  return `${text} ${BYTE_UNITS[unit]}`;
}
