// 生成 hook-gen.ts：把 hook 的 react 导入替换为测试 shim。
// 运行：node gen-hook.mjs（或 deno run gen-hook.mjs）
import { readFileSync, writeFileSync } from "node:fs";
const src = readFileSync(new URL("../useComposerSubmission.ts", import.meta.url), "utf8");
writeFileSync(new URL("./hook-gen.ts", import.meta.url), src.replace('from "react"', 'from "./react-shim.mjs"'));
