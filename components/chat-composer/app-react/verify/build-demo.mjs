import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
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
  return outdir;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildDemo();
