// esbuild 构建：demo.ts → .runtime/island.js（iife，自执行挂 window.createController）。
// 同时产出 metafile 供「零 React 泄漏」审计（失效模式 3）。
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const outdir = join(root, ".runtime");
await mkdir(outdir, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["demo/demo.ts"],
  bundle: true,
  outfile: join(".runtime", "island.js"),
  format: "iife",
  target: "es2022",
  metafile: true,
  write: true,
});
await writeFile(join(outdir, "metafile.json"), JSON.stringify(result.metafile));
console.log("island bundle built:", join(".runtime", "island.js"));
