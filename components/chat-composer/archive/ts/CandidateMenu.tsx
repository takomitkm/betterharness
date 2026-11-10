import { useEffect, useId, useRef } from "react";

export interface MenuOption {
  key: string;
  label: string;
}

export interface CandidateMenuProps {
  open: boolean;
  /** 结果未到：显示骨架行（v1 用骨架替代「保留旧行但禁选」，见 completion.ts）。 */
  pending: boolean;
  options: MenuOption[];
  highlightIndex: number;
  onHighlight: (index: number) => void;
  onPick: (index: number) => void;
  onDismiss: () => void;
}

/**
 * 候选菜单（DSH 对齐的输入框 overlay）：listbox + aria-activedescendant，
 * 渲染在输入框上方（composer 卡片内）。行上的 mousedown 阻止默认夺焦以保持编辑器选区；
 * 真实 mousemove 才移动共享高亮；卡片与菜单之外的 pointerdown 关闭菜单。
 * 数据全部来自 Integration 的镜像（menuMirror），不直接读引擎。
 */
export function CandidateMenu({ open, pending, options, highlightIndex, onHighlight, onPick, onDismiss }: CandidateMenuProps) {
  const idPrefix = useId();
  // 只响应真实指针移动：同一位置的重复 mousemove（滚动/重渲染触发）不得抢走高亮。
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element) {
        // 菜单本身与 composer 卡片内部的按下不关闭（编辑器内点击由光标重检测接管）。
        if (target.closest(".candidate-menu") || target.closest(".chat-composer")) return;
      }
      onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, onDismiss]);

  if (!open) return null;
  return (
    <div
      className="candidate-menu"
      data-testid="candidate-menu"
      style={{
        background: "var(--paper, #fffefb)", border: "1px solid var(--line, #d9e4df)", borderRadius: 10,
        boxShadow: "0 10px 26px rgba(23, 43, 42, 0.14)", margin: "0 0 8px",
        maxHeight: 280, overflowY: "auto",
      }}
    >
      {pending && options.length === 0 && <>
        <div className="candidate-skeleton" aria-hidden="true" style={{ height: 14, width: "62%", margin: "10px 12px", background: "#edf3ec", borderRadius: 4 }} />
        <div className="candidate-skeleton" aria-hidden="true" style={{ height: 14, width: "44%", margin: "10px 12px", background: "#edf3ec", borderRadius: 4 }} />
      </>}
      {options.length > 0 && <ul
        role="listbox"
        aria-label="候选列表"
        aria-activedescendant={highlightIndex >= 0 ? `${idPrefix}-option-${highlightIndex}` : undefined}
        style={{ listStyle: "none", margin: 0, padding: 4 }}
      >
        {options.map((option, index) => (
          <li
            key={option.key}
            id={`${idPrefix}-option-${index}`}
            role="option"
            aria-selected={index === highlightIndex}
            data-testid="candidate-option"
            style={{
              padding: "6px 10px", borderRadius: 6, cursor: "pointer",
              background: index === highlightIndex ? "#e2f0e9" : "transparent",
            }}
            onMouseDown={(event) => { event.preventDefault(); }}
            onMouseMove={(event) => {
              const last = lastPointerRef.current;
              if (last && last.x === event.clientX && last.y === event.clientY) return;
              lastPointerRef.current = { x: event.clientX, y: event.clientY };
              if (index !== highlightIndex) onHighlight(index);
            }}
            onClick={() => onPick(index)}
          >{option.label}</li>
        ))}
      </ul>}
      {!pending && options.length === 0 && <div className="candidate-empty" style={{ padding: "8px 12px", color: "var(--muted, #596d69)", fontSize: 13 }}>无匹配候选</div>}
    </div>
  );
}
