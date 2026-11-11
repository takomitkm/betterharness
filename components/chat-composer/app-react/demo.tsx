import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer, TextareaEditor, type CompletionProvider, type EditorProps } from "./ChatComposer.tsx";
import { LexicalEditor } from "./LexicalEditor.tsx";
import { createComposer, type EngineFace } from "./core.ts";
import { createWasmEngine } from "./src/composer/WasmEngine.ts";
import { openIdbStateStore } from "./src/hosts/web/persist.ts";
import { IndexedDbComposerStore } from "./store.ts";
import { createHttpTransport } from "./http-transport.ts";
import { useComposerSubmission } from "./useComposerSubmission.ts";
import type { IntakePolicy } from "./intake.ts";
import type { AssetId, ComposerStore } from "./types.ts";

// 演示准入策略：真实可触发的上限（通用文件，不做图片白名单）——
// 超 2 MiB 的文件按单文件大小逐文件拒绝（不连坐同批正常文件），第 7 个文件整批拒绝。
const DEMO_INTAKE_POLICY: IntakePolicy = {
  maxFiles: 6,
  maxBytesPerFile: 2 * 1024 * 1024,
};

// 演示候选源：固定内存列表（@ 文件引用、/ 命令回显）。生产宿主在这里接真实的文件/命令检索。
const DEMO_REFERENCES = [
  { label: "field-report.md", insertText: "@field-report.md" },
  { label: "final-notes.md", insertText: "@final-notes.md" },
  { label: "s1-alpha.md", insertText: "@s1-alpha.md" },
  { label: "s2-beta.md", insertText: "@s2-beta.md" },
  { label: "服务器架构.png", insertText: "@服务器架构.png" },
];
const DEMO_COMMANDS = [
  { label: "/help 帮助", insertText: "/帮助" },
  { label: "/clear 清理上下文", insertText: "/清理上下文" },
];
const demoCompletionProvider: CompletionProvider = (kind, query) => {
  const source = kind === "reference" ? DEMO_REFERENCES : DEMO_COMMANDS;
  const needle = query.toLowerCase();
  return source.filter((item) => item.label.toLowerCase().includes(needle) || item.insertText.toLowerCase().includes(needle));
};
// 浏览器测试经 composerTest.setCompletionProvider 注入慢/快候选源替身，验证代次守卫。
let completionOverride: CompletionProvider | null = null;

// 浏览器测试经 composerTest.moveAttachment 直接调用 moveAttachmentNode（rail 按钮之外的
// 编程路径）。编辑器挂载时把注册进来的移动入口镜像到这里，卸载时（含 StrictMode 重挂）置回 null。
let testAttachmentMover: ((assetId: AssetId, targetAttachmentIndex: number) => void) | null = null;

function DemoLexicalEditor(props: EditorProps) {
  return <LexicalEditor {...props} registerAttachmentMover={(move) => {
    testAttachmentMover = move;
    props.registerAttachmentMover?.(move);
  }} />;
}

const parameters = new URLSearchParams(location.search);
const scopeId = parameters.get("scope") ?? "demo/main";
const store = await IndexedDbComposerStore.open(parameters.get("database") ?? "betterharness-composer-demo");
let scenario = "normal";
let writeFailures = 0;
let holdWrite = false;
let releaseWrite: (() => void) | null = null;
let writeGateHit = false;
const instrumented: ComposerStore = {
  read: (scope) => store.read(scope),
  async compareAndSwap(scope, revision, next) {
    if (writeFailures > 0) { writeFailures--; throw new Error("演示：本地写入失败"); }
    if (holdWrite) {
      holdWrite = false;
      writeGateHit = true;
      await new Promise<void>((resolve) => { releaseWrite = resolve; });
    }
    return store.compareAndSwap(scope, revision, next);
  },
};
// engine=wasm 走真实 Rust Core WASM（PRODUCT-LINE-PLAN Phase 3 首要链路）；
// 默认 TS 引擎承载 B 系列全量测试（受控 Adapter，见 WasmEngine/README 的范围说明）。
const wasmPersist = parameters.get("wasm") === "1"
  ? await openIdbStateStore("composer-bridge-state")
  : null;
const engine = parameters.get("wasm") === "1"
  ? await createWasmEngine({
      scopeId, store: instrumented, transport: createHttpTransport(new URL("./", location.href).href, () => scenario),
      sendTimeoutMs: Number(parameters.get("timeout") ?? 1500),
    }, wasmPersist)
  : await createComposer({
      scopeId, store: instrumented, transport: createHttpTransport(new URL("./", location.href).href, () => scenario),
      sendTimeoutMs: Number(parameters.get("timeout") ?? 1500),
    });

// This bridge exists in the demo only; browser tests inspect real production state and inject boundary faults.
Object.assign(window, {
  composerTest: {
    engine: engine as unknown as import("./core.ts").ComposerEngine, store,
    failWrite() { writeFailures++; },
    holdWrite() { holdWrite = true; writeGateHit = false; },
    get writeGateHit() { return writeGateHit; },
    releaseWrite() { releaseWrite?.(); releaseWrite = null; },
    setCompletionProvider(provider: CompletionProvider | null) { completionOverride = provider; },
    moveAttachment(assetId: string, targetAttachmentIndex: number) {
      testAttachmentMover?.(assetId as AssetId, targetAttachmentIndex);
    },
  },
});

function App() {
  const view = useComposerSubmission(engine);
  const [editor, setEditor] = useState(parameters.get("editor") === "rich" ? "rich" : "text");
  const [behavior, setBehavior] = useState("normal");
  const [mode, setMode] = useState("queue");
  const [executions, setExecutions] = useState(0);
  useEffect(() => {
    let active = true;
    void fetch("api/stats").then((response) => response.json()).then((stats) => {
      if (active) setExecutions(stats.executions);
    });
    return () => { active = false; };
  }, [view.state.revision]);
  return <main>
    <header><p className="eyebrow">BETTERHARNESS · CHAT COMPOSER</p><h1>消息交出去，新草稿留下来。</h1>
      <p>真实 React / Lexical、IndexedDB 与回执协议。输入框不会因为迟到回执而清掉新内容。</p></header>
    <section className="demo-settings" aria-label="演示设置">
      <label>编辑器 <select data-testid="editor-mode" value={editor} onChange={(event) => setEditor(event.target.value)}>
        <option value="text">纯文本</option><option value="rich">Lexical + mention</option>
      </select></label>
      <label>本轮运行时 <select data-testid="busy-mode" value={mode} onChange={(event) => {
        const mode = event.target.value as "queue" | "steer" | "none"; setMode(mode); engine.setBusyMode(mode);
      }}><option value="queue">排队</option><option value="steer">插话</option><option value="none">只保留草稿</option></select></label>
      <label>下一次传输 <select data-testid="scenario" value={behavior} onChange={(event) => {
        scenario = event.target.value; setBehavior(scenario);
      }}><option value="normal">正常接纳</option><option value="reject">明确未接纳</option>
        <option value="lost-ack">已接纳但丢失回执</option><option value="hold">暂扣回执</option>
      </select></label>
    </section>
    <ChatComposer
      engine={engine}
      Editor={editor === "rich" ? DemoLexicalEditor : TextareaEditor}
      completionProvider={(kind, query) => (completionOverride ?? demoCompletionProvider)(kind, query)}
      intakePolicy={DEMO_INTAKE_POLICY}
    />
    <section className="host-controls" aria-label="宿主事件演示">
      <button type="button" data-testid="end-turn" disabled={!view.state.activeTurn} onClick={() => {
        if (view.state.activeTurn) void engine.endTurn(view.state.activeTurn);
      }}>结束当前轮次</button>
      <button type="button" data-testid="release" onClick={() => void fetch("api/release", { method: "POST" })}>释放暂扣回执</button>
      <span>服务端实际接纳：<strong data-testid="executions">{executions}</strong> 条</span>
    </section>
    <footer>刷新可恢复草稿、附件和提交记录。待确认消息只核对，不自动重发。演示服务不是模型服务。</footer>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
