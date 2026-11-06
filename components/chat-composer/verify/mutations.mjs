import { mkdtemp, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const source = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'composer-mutations-'));
const tests = ['verify/core.test.ts', 'verify/recovery.test.ts', 'verify/adapter.test.ts', 'verify/durability.test.ts'];
const variants = [
  ['retained-submitted-text', 'core.ts', 'next.draft = this.newDraft();', 'next.draft = this.newDraft(captured.snapshot);', 'verify/core.test.ts', 'FM01'],
  ['late-result-clears-new-draft', 'core.ts', '// If saving the receipt fails,', 'this.draft = this.newDraft();\n      // If saving the receipt fails,', 'verify/core.test.ts', 'FM02|FM04'],
  ['unknown-treated-as-rejection', 'core.ts', 'record.status = result.status;', 'record.status = result.status === "unknown" ? "rejected" : result.status;', 'verify/core.test.ts', 'FM03'],
  ['cas-conflict-ignored', 'core.ts', 'if (!saved) {\n      this.paused = true;', 'if (false) {\n      this.paused = true;', 'verify/core.test.ts', 'FM14'],
  ['restore-overwrites-current-draft', 'core.ts', 'if (this.closed || this.admitting || !isEmptyDraft(this.draft.snapshot)) return Promise.resolve(false);', 'if (this.closed || this.admitting) return Promise.resolve(false);', 'verify/core.test.ts', 'FM05'],
  ['finished-turn-revived', 'core.ts', '!next.finishedTurns.includes(result.receipt.turnId) && ', '', 'verify/recovery.test.ts', 'FM17'],
  ['local-recovery-does-not-pump', 'core.ts', 'this.pump();\n    return this.pendingResults.size === 0 && !this.view.dirty;', 'return this.pendingResults.size === 0 && !this.view.dirty;', 'verify/durability.test.ts', 'FM24'],
  ['cyclic-document-admitted', 'snapshots.ts', 'validateJson(snapshot.document.value);', '// skipped document validation', 'verify/recovery.test.ts', 'FM19'],
  ['stale-editor-result-applied', 'editor-adapter.ts', 'if (current.generation !== expected.generation || current.revision !== expected.revision) return Promise.resolve(false);', '// missing version guard', 'verify/adapter.test.ts', 'FM20'],
  ['corrupt-schema-accepted', 'snapshots.ts', 'state.schema !== 1', 'false', 'verify/adapter.test.ts', 'FM22'],
  ['snapshot-loses-attachments', 'core.ts', 'snapshot: copy(captured.snapshot), status: "queued",', 'snapshot: { text: captured.snapshot.text, attachments: [], references: [] }, status: "queued",', 'verify/core.test.ts', 'FM08'],
  ['repeat-submits-message', 'core.ts', 'if (!event.repeat) void this.submit();', 'void this.submit();', 'verify/core.test.ts', 'FM16'],
  ['stale-lookup-downgrades-rejection', 'core.ts', 'if (record.status === "rejected" && result.status === "unknown") { forget(); return false; }', '// missing monotonic result guard', 'verify/recovery.test.ts', 'FM25'],
  ['cleared-before-durable-commit', 'core.ts', '// Both payload ownership and the empty successor draft are one durable transaction.', 'this.draft = copy(next.draft);\n      // Both payload ownership and the empty successor draft are one durable transaction.', 'verify/core.test.ts', 'FM06'],
];

function run(directory, files, pattern) {
  return spawnSync(process.execPath, ['--test', ...(pattern ? ['--test-name-pattern=' + pattern] : []), ...files], {
    cwd: directory, encoding: 'utf8', timeout: 16000,
  });
}

try {
  const baseline = run(source, tests);
  assert.equal(baseline.status, 0, 'Baseline must be green before mutation: ' + baseline.stdout + baseline.stderr);
  console.log('BASELINE: PASS');
  for (const [name, file, before, after, testFile, pattern] of variants) {
    const directory = join(scratch, name);
    await cp(source, directory, { recursive: true, filter: (path) => !['node_modules', '.runtime'].includes(basename(path)) });
    const path = join(directory, file);
    const text = await readFile(path, 'utf8');
    assert.equal(text.split(before).length - 1, 1, name + ': mutation target must match exactly once');
    await writeFile(path, text.replace(before, after), 'utf8');
    const result = run(directory, [testFile], pattern);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, 1, name + ': expected test failure, got ' + result.status + '\n' + output);
    assert.ok(output.includes('FM'), name + ': actual contract test must run');
    assert.ok(!/SyntaxError|ERR_MODULE_NOT_FOUND/.test(output), name + ': an import/parser error is not a killed mutation');
    console.log('KILLED: ' + name + ' -> ' + pattern);
    await rm(directory, { recursive: true, force: true });
  }
  console.log(`${variants.length}/${variants.length} behavior mutations killed; original source unchanged`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
