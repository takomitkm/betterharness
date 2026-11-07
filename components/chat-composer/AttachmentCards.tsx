import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AssetId, Attachment } from "./types.ts";
import { formatBytes, type IntakePolicy } from "./intake.ts";

// 附件呈现（对应 DSH ui-attachment 的 AttachmentRail / FileCard / DropOverlay / 预览）：
//   - 图片缩略图：object-URL 预览，点击开灯箱；文件卡：类型占位符/扩展名首字母、名称、扩展名+大小、移除；
//   - 横向 rail：边缘翻页箭头按滚动几何 + ResizeObserver 重算；滚轮只横滚 rail
//     （非 passive 监听、preventDefault、LINE/PAGE 增量归一、每格钳制、reduced-motion 降级）；
//   - 新附件滚入视野；整个 rail 因草稿清空而卸载、又随附件重新挂载时保持起始位置（不跳到末尾）；
//   - object-URL 纪律：每个视图（缩略图/灯箱）拥有自己的 URL，按 AssetId 创建、卸载/换资产即释放；
//     被移除资产的晚到预览加载不会复活卡片（URL 已随卸载失效，卡片本身也从快照消失）。
// 本文件只做呈现：数据全部来自快照，无上传生命周期（字节在本地，发送载荷已携带；见 README）。

/** 拖放遮罩的限额文案（演示与宿主共用；纯文本拼装，无策略时返回空串）。 */
export function intakeLimitsText(policy: IntakePolicy): string {
  const parts: string[] = [];
  if (policy.maxFiles !== undefined) parts.push(`最多 ${policy.maxFiles} 个文件`);
  if (policy.maxBytesPerFile !== undefined) parts.push(`单个不超过 ${formatBytes(policy.maxBytesPerFile)}`);
  if (policy.maxBytesTotal !== undefined) parts.push(`总共不超过 ${formatBytes(policy.maxBytesTotal)}`);
  if (policy.allowedMediaTypes?.length) parts.push(`仅支持 ${[...policy.allowedMediaTypes].join("、")}`);
  return parts.join(" · ");
}

/** 全视口拖放邀请（DSH DragMask 同款）：装饰层，pointer-events: none 让拖放目标穿透到页面，
 * 文档级监听保持准确的 enter/leave 计数并独占 accept/reject。经 body portal 渲染，躲开变换祖先。 */
export function DropOverlay({ disabled, title, desc }: { disabled: boolean; title: string; desc?: string }) {
  return createPortal(
    <div className="drop-overlay" data-testid="drop-overlay" role="status">
      <div className="drop-overlay-card" data-disabled={disabled ? "true" : "false"}>
        <div className="drop-overlay-title">{title}</div>
        {!disabled && desc && <div className="drop-overlay-desc">{desc}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function isImageType(mediaType: string): boolean {
  return mediaType.startsWith("image/");
}

/** 文件扩展名（小写）；无扩展名或以点结尾返回空串。 */
export function fileExtensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * 按资产身份创建 object URL：依赖只有 AssetId——引擎每次发布都会 structuredClone 快照，
 * Blob 是字节相同的新副本，不能按对象身份重建 URL。effect 闭包始终来自最近一次渲染，
 * 换资产时拿到的是新资产的 Blob。卸载或换资产即释放——被移除资产的晚到预览加载
 * 因此不可能复活卡片。
 */
function useAssetUrl(assetId: AssetId, data: Blob): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const created = URL.createObjectURL(data);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
    // 故意只依赖 assetId：Blob 身份会因快照克隆而漂移，字节本身不可变。
  }, [assetId]);
  return url;
}

function ImageThumb({ attachment, disabled, onRemove, onOpen }: {
  attachment: Attachment; disabled: boolean; onRemove: () => void; onOpen: () => void;
}) {
  const url = useAssetUrl(attachment.id, attachment.data);
  return <span className="attachment-image" data-testid="attachment-thumb" data-asset-id={attachment.id}>
    <button type="button" className="attachment-image-open" title="点击放大" aria-label={`查看 ${attachment.name}`} disabled={url === null} onClick={onOpen}>
      {url === null ? <span className="attachment-image-pending" aria-hidden="true">…</span> : <img src={url} alt={attachment.name} />}
    </button>
    <button type="button" className="attachment-remove" disabled={disabled} aria-label={`移除 ${attachment.name}`} onClick={onRemove}>×</button>
  </span>;
}

function FileCardView({ attachment, disabled, onRemove }: { attachment: Attachment; disabled: boolean; onRemove: () => void }) {
  const extension = fileExtensionOf(attachment.name).toUpperCase().slice(0, 8);
  const meta = [extension, formatBytes(attachment.data.size)].filter((part) => part !== "").join(" · ");
  return <span className="attachment-file" data-testid="attachment-card" data-asset-id={attachment.id} title={attachment.name}>
    <span className="attachment-file-icon" aria-hidden="true">{extension.charAt(0) || "文"}</span>
    <span className="attachment-file-body" aria-label={`待发送文件 ${attachment.name}`}>
      <span className="attachment-file-name">{attachment.name}</span>
      <span className="attachment-file-meta">{meta || formatBytes(attachment.data.size)}</span>
    </span>
    <button type="button" className="attachment-remove" disabled={disabled} aria-label={`移除 ${attachment.name}`} onClick={onRemove}>×</button>
  </span>;
}

/** 图片灯箱：自己拥有独立的 object URL；Esc 或点击背景关闭。 */
function Lightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const url = useAssetUrl(attachment.id, attachment.data);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`预览 ${attachment.name}`} data-testid="lightbox" onClick={onClose}>
      {url && <img src={url} alt={attachment.name} />}
      <button type="button" className="lightbox-close" aria-label="关闭预览" onClick={onClose}>关闭预览</button>
    </div>,
    document.body,
  );
}

interface RailItem {
  id: AssetId;
}

/** Firefox 棘轮滚轮按行报告增量时的近似像素换算（DSH AttachmentRail 同款）。 */
const WHEEL_LINE_PX = 16;

/** 平滑翻页，除非用户系统要求减少动效。 */
function pageBehavior(): ScrollBehavior {
  const matchMedia = (window as { matchMedia?: Window["matchMedia"] }).matchMedia;
  return matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * 横向附件 rail：滚动条隐藏，溢出用边缘箭头翻页（按滚动几何在 scroll/数量/rail 尺寸变化时重算，
 * ResizeObserver 观察元素本身——侧栏/面板宽度变化也计入）。纵向滚轮横滚 rail 且独占消费；
 * 新增附件滚到末尾露出；在已有草稿上重新挂载是初次布局而非增长，保持起始位置。
 */
function AttachmentRail<T extends RailItem>({ items, renderItem }: { items: readonly T[]; renderItem: (item: T) => ReactNode }) {
  const railRef = useRef<HTMLDivElement | null>(null);
  // null 标记首次布局：在已有草稿上重新挂载时不得跳到末尾。
  const countRef = useRef<number | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const updateEdges = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    // 1px 余量：滚动位置在边缘处可能是小数。
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 1;
    setEdges((previous) => (previous.left === left && previous.right === right ? previous : { left, right }));
  }, []);
  useLayoutEffect(() => {
    const grew = countRef.current !== null && items.length > countRef.current;
    countRef.current = items.length;
    const el = railRef.current;
    if (!el) return;
    if (grew) el.scrollLeft = el.scrollWidth - el.clientWidth;
    updateEdges();
  }, [items.length, updateEdges]);
  useEffect(() => {
    const el = railRef.current;
    if (!el) return;
    let disconnect = (): void => {};
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(updateEdges);
      observer.observe(el);
      disconnect = () => observer.disconnect();
    }
    // rail 只横滚：带纵向分量的滚轮被独占消费（非 passive——React 根上的 wheel 监听是 passive 的），
    // 否则会同时滚动后方的对话。LINE/PAGE 增量先归一成像素再做每格钳制，快速滚动仍跟手。
    const onWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return;
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_LINE_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientWidth : 1;
      event.preventDefault();
      el.scrollBy({
        left: event.deltaX !== 0
          ? event.deltaX * scale
          : Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY) * scale, 60),
        behavior: "auto",
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      disconnect();
      el.removeEventListener("wheel", onWheel);
    };
  }, [updateEdges]);
  const page = (direction: -1 | 1): void => {
    const el = railRef.current;
    if (!el) return;
    // 一屏减一张卡片：保留最后一张可见缩略图作上下文；下限保证窄 rail 也能翻出有用距离。
    el.scrollBy({ left: direction * Math.max(el.clientWidth - 64, 200), behavior: pageBehavior() });
  };
  return <div className="attachment-rail-root">
    {edges.left && <button type="button" className="rail-arrow" aria-label="向前翻" onClick={() => page(-1)}>‹</button>}
    <div ref={railRef} className="attachment-rail" role="group" aria-label="草稿附件" data-testid="attachment-rail" onScroll={updateEdges}>
      {items.map((item) => <span key={item.id} className="rail-item">{renderItem(item)}</span>)}
    </div>
    {edges.right && <button type="button" className="rail-arrow" aria-label="向后翻" onClick={() => page(1)}>›</button>}
  </div>;
}

export interface AttachmentCardsProps {
  /** 草稿附件条目（快照事实来源）。 */
  attachments: readonly Attachment[];
  /** 交接窗口（admitting）：移除按钮禁用，与其它编辑入口一致。 */
  disabled: boolean;
  onRemove: (id: AssetId) => void;
}

/** 草稿附件的卡片呈现：图片缩略图 + 文件卡 + 灯箱，装在横向 rail 里。没有附件时不渲染。 */
export function AttachmentCards({ attachments, disabled, onRemove }: AttachmentCardsProps) {
  // 灯箱以 AssetId 记忆：对应附件被移除时预览必须跟着关（DSH：图片消失时关闭它的预览）。
  const [previewId, setPreviewId] = useState<AssetId | null>(null);
  useEffect(() => {
    if (previewId !== null && !attachments.some((item) => item.id === previewId)) setPreviewId(null);
  }, [attachments, previewId]);
  const preview = previewId === null ? null : attachments.find((item) => item.id === previewId) ?? null;
  // hooks 必须在顶层先全部执行完，之后才允许按内容提前返回。
  if (attachments.length === 0) return null;
  const items = attachments.map((attachment) => ({ id: attachment.id, attachment }));
  return <>
    <AttachmentRail items={items} renderItem={({ attachment }) => (
      isImageType(attachment.mediaType)
        ? <ImageThumb attachment={attachment} disabled={disabled} onRemove={() => onRemove(attachment.id)} onOpen={() => setPreviewId(attachment.id)} />
        : <FileCardView attachment={attachment} disabled={disabled} onRemove={() => onRemove(attachment.id)} />
    )} />
    {preview && <Lightbox attachment={preview} onClose={() => setPreviewId(null)} />}
  </>;
}
