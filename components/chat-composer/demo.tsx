import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer, TextareaEditor } from "./ChatComposer.tsx";
import { LexicalEditor } from "./LexicalEditor.tsx";
import { createComposer } from "./core.ts";
import { IndexedDbComposerStore } from "./store.ts";
import { createHttpTransport } from "./http-transport.ts";
import { useComposerSubmission } from "./useComposerSubmission.ts";
import type { ComposerStore } from "./types.ts";

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
const engine = await createComposer({
  scopeId, store: instrumented, transport: createHttpTransport(new URL("./", location.href).href, () => scenario),
  sendTimeoutMs: Number(parameters.get("timeout") ?? 1500),
});

// This bridge exists in the demo only; browser tests inspect real production state and inject boundary faults.
Object.assign(window, {
  composerTest: {
    engine, store,
    failWrite() { writeFailures++; },
    holdWrite() { holdWrite = true; writeGateHit = false; },
    get writeGateHit() { return writeGateHit; },
    releaseWrite() { releaseWrite?.(); releaseWrite = null; },
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
    <ChatComposer engine={engine} Editor={editor === "rich" ? LexicalEditor : TextareaEditor} />
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
