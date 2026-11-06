// @vitest-environment jsdom
/**
 * ChatComposer 渲染层集成测试（真实 React 19 渲染 + jsdom）。
 *
 * 与 useComposerSubmission.test.mts（纯逻辑、React stub）互补：
 * 这里验证的是「状态 → DOM 的流动」，Deno stub 测不到的部分：
 * - 受控 textarea 的值随状态清空/恢复
 * - keydown 合成事件被 React onKeyDown 接收并 preventDefault
 * - 失败项 UI（重试/放弃按钮）的出现与消失
 * - 草稿落盘走 jsdom 的 localStorage，重挂载真正恢复
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatComposer } from "../ChatComposer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
});

function mount(props: Parameters<typeof ChatComposer>[0] = {}) {
  act(() => {
    root = createRoot(host);
    root.render(<ChatComposer {...props} />);
  });
}

const ta = () => host.querySelector("textarea") as HTMLTextAreaElement;
const failedItems = () => host.querySelectorAll(".chat-composer__failed li");

// React 对受控 textarea 安装了 value tracker：直接 el.value = v 后 dispatch input
// 不会触发 onChange，必须走原型上的 native value setter（fireEvent.change 的内部做法）。
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLTextAreaElement.prototype,
  "value",
)!.set!;

const type = (v: string) =>
  act(() => {
    const el = ta();
    nativeValueSetter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });

function unmount() {
  act(() => {
    root?.unmount();
  });
  root = null;
}

/** 派发 keydown，返回合成事件是否 preventDefault（React 会转发到原生事件） */
function keyDown(k: string, init: KeyboardEventInit = {}) {
  const ev = new KeyboardEvent("keydown", {
    key: k,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => {
    ta().dispatchEvent(ev);
  });
  return { defaultPrevented: ev.defaultPrevented };
}
/** 让 React 的异步状态更新落地（act 包裹的微任务 flush） */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function deferredPromise<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ChatComposer 渲染层（真实 React 19 + jsdom）", () => {
  it("R1 输入 + Enter：onSubmit 收到正文，编辑器立即清空", async () => {
    const sent: string[] = [];
    mount({ onSubmit: async (t) => { sent.push(t); } });
    type("第一句话");
    const r = keyDown("Enter");
    expect(sent).toEqual(["第一句话"]);
    expect(ta().value).toBe("");
    expect(r.defaultPrevented).toBe(true);
  });

  it("R2 快速双击 Enter：只发送一次", async () => {
    const sent: string[] = [];
    mount({ onSubmit: async (t) => { sent.push(t); } });
    type("A");
    keyDown("Enter");
    keyDown("Enter");
    expect(sent.length).toBe(1);
    expect(ta().value).toBe("");
  });

  it("R3 提交在途按 Enter：被消费（defaultPrevented），编辑器保持空、无换行", async () => {
    const gate = deferredPromise();
    const sent: string[] = [];
    mount({ onSubmit: async (t) => { sent.push(t); await gate.promise; } });
    type("A");
    keyDown("Enter");
    expect(sent.length).toBe(1);
    const r = keyDown("Enter");
    expect(r.defaultPrevented).toBe(true);
    expect(ta().value).toBe("");
    expect(host.textContent).not.toContain("\n");
    gate.resolve();
    await flush();
    expect(ta().value).toBe("");
  });

  it("R4 Shift+Enter：不被消费（换行由编辑器默认行为负责），不发送", () => {
    const sent: string[] = [];
    mount({ onSubmit: async (t) => { sent.push(t); } });
    type("L1");
    const r = keyDown("Enter", { shiftKey: true });
    expect(r.defaultPrevented).toBe(false); // 显式换行不被吞
    type("L1\n"); // jsdom 不模拟按键插入文本，手动等价模拟浏览器的换行结果
    type("L2");
    expect(ta().value).toBe("L1\nL2");
    expect(sent.length).toBe(0);
  });

  it("R5 IME 组合中回车：不发送、不被消费", () => {
    const sent: string[] = [];
    mount({ onSubmit: async (t) => { sent.push(t); } });
    type("nihao");
    const r = keyDown("Enter", { isComposing: true });
    expect(sent.length).toBe(0);
    expect(r.defaultPrevented).toBe(false); // IME 组合中不拦（回车确认候选）
  });

  it("R6 空输入回车：不发送", () => {
    const sent: string[] = [];
    mount({ onSubmit: async (t) => { sent.push(t); } });
    keyDown("Enter");
    expect(sent.length).toBe(0);
  });

  it("R7 发送失败：正文恢复到空编辑器 + 失败项 UI 出现", async () => {
    const gate = deferredPromise();
    mount({
      onSubmit: async () => {
        await gate.promise;
        throw new Error("send-failed");
      },
    });
    type("B");
    keyDown("Enter");
    expect(ta().value).toBe("");
    gate.resolve();
    await flush();
    expect(ta().value).toBe("B");
    expect(failedItems().length).toBe(1);
  });

  it("R8 失败 + 用户已写新草稿：新草稿保留，失败项并列出现", async () => {
    const gate = deferredPromise();
    mount({
      onSubmit: async () => {
        await gate.promise;
        throw new Error("send-failed");
      },
    });
    type("A");
    keyDown("Enter");
    type("B-new");
    gate.resolve();
    await flush();
    expect(ta().value).toBe("B-new");
    expect(failedItems().length).toBe(1);
  });

  it("R9 失败项的重试按钮：直接重发并清空失败项", async () => {
    let calls = 0;
    let ok = false;
    mount({
      onSubmit: async () => {
        calls += 1;
        if (calls === 1) throw new Error("fail-first");
        ok = true;
      },
    });
    type("retry-me");
    keyDown("Enter");
    await flush();
    expect(failedItems().length).toBe(1);
    act(() => {
      (failedItems()[0]!.querySelector("button") as HTMLButtonElement).click();
    });
    await flush();
    expect(ok).toBe(true);
    expect(failedItems().length).toBe(0);
    expect(ta().value).toBe("");
  });

  it("R10 失败项的放弃按钮：条目消失，编辑器不受影响", async () => {
    const gate = deferredPromise();
    mount({
      onSubmit: async () => {
        await gate.promise;
        throw new Error("x");
      },
    });
    type("give-up");
    keyDown("Enter");
    gate.resolve();
    await flush();
    expect(failedItems().length).toBe(1);
    const buttons = failedItems()[0]!.querySelectorAll("button");
    act(() => {
      (buttons[1] as HTMLButtonElement).click();
    });
    expect(failedItems().length).toBe(0);
    // 放弃语义：失败条目消失，编辑器保留正文（用户可自行编辑后再发）
    expect(ta().value).toBe("give-up");
  });

  it("R11 草稿持久化：防抖落盘 + 受理同步清空 + 发送成功后不复活", async () => {
    mount({ draftKey: "ck-r11", onSubmit: async () => {} });
    type("draft text");
    expect(localStorage.getItem("ck-r11")).toBeNull(); // 防抖期内未落盘
    await new Promise((r) => setTimeout(r, 400));
    expect(localStorage.getItem("ck-r11")).toBe("draft text"); // 防抖后落盘
    keyDown("Enter");
    expect(localStorage.getItem("ck-r11")).toBe(""); // 受理同步清空（不等防抖）
  });

  it("R12 重挂载恢复草稿", async () => {
    mount({ draftKey: "ck-r12", onSubmit: async () => {} });
    type("unsent draft");
    await new Promise((r) => setTimeout(r, 400));
    unmount();
    mount({ draftKey: "ck-r12", onSubmit: async () => {} });
    expect(ta().value).toBe("unsent draft");
    localStorage.removeItem("ck-r12");
  });

  it("R13 发送成功后草稿不被重挂载恢复（不复活已发正文）", async () => {
    mount({ draftKey: "ck-r13", onSubmit: async () => {} });
    type("sent-already");
    keyDown("Enter");
    expect(localStorage.getItem("ck-r13")).toBe("");
    unmount();
    mount({ draftKey: "ck-r13", onSubmit: async () => {} });
    expect(ta().value).toBe("");
    localStorage.removeItem("ck-r13");
  });
});