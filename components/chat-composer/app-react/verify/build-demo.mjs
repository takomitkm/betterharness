import { build } from 'esbuild';
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export async function buildDemo() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const outdir = join(root, '.runtime');
  await mkdir(outdir, { recursive: true });
  await build({
    absWorkingDir: root, entryPoints: ['demo.tsx'], bundle: true, outdir,
    format: 'esm', target: 'es2022', jsx: 'automatic', sourcemap: true,
  });
  await copyFile(join(root, 'demo.html'), join(outdir, 'index.html'));
  // 真实 Rust Core WASM（wasm=1）：vendor 不存在时跳过（纯 TS 模式仍可运行）。
  try {
    const vendor = join(outdir, 'vendor');
    await mkdir(vendor, { recursive: true });
    for (const name of await readdir(join(root, 'vendor'))) {
      await copyFile(join(root, 'vendor', name), join(vendor, name));
    }
  } catch { /* vendor 未构建：wasm=1 不可用，TS 模式不受影响 */ }
  return outdir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildDemo();
