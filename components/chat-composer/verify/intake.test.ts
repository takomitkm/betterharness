import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, intakeFiles, splitClipboard } from "../intake.ts";
import type { FileMeta, IntakePolicy } from "../intake.ts";

// intakeFiles 的基准输入：纯构造 FileMeta，不碰任何浏览器对象（零 react/lexical 依赖）。
function meta(name: string, bytes: number, mediaType = "application/octet-stream"): FileMeta {
  return { name, mediaType, bytes };
}
const noPolicy: IntakePolicy = {};

test("IT01: with no policy every file is accepted and keeps its original object identity", () => {
  const first = meta("a.png", 10, "image/png");
  const second = meta("b.txt", 3, "text/plain");
  const decision = intakeFiles([first, second], noPolicy, []);
  assert.deepEqual(decision.rejected, []);
  // accepted 就是传入对象本体：宿主据此找回原始 File/Blob，不允许复制重建。
  assert.equal(decision.accepted[0], first);
  assert.equal(decision.accepted[1], second);
});

test("IT02: maxFiles is existing + incoming and rejects the whole batch before anything is added", () => {
  const batch = [meta("a.txt", 1), meta("b.txt", 1), meta("c.txt", 1)];
  // 已有 5 个 + 3 个 > 6：整批拒绝，reason 全部为 too_many。
  assert.deepEqual(
    intakeFiles(batch, { maxFiles: 6 }, [meta("x", 0), meta("y", 0), meta("z", 0), meta("p", 0), meta("q", 0)]),
    {
      accepted: [],
      rejected: [
        { name: "a.txt", reason: "too_many" },
        { name: "b.txt", reason: "too_many" },
        { name: "c.txt", reason: "too_many" },
      ],
    },
  );
  // 恰好达到上限（5+1=6）不算违规；整批语义优先于逐文件检查（即使批次里有超大文件也不改变原因）。
  const decision = intakeFiles([batch[0]], { maxFiles: 6, maxBytesPerFile: 0 }, Array.from({ length: 5 }, () => meta("e", 0)));
  assert.deepEqual(decision.rejected, [{ name: "a.txt", reason: "file_too_large" }]);
});

test("IT03: maxBytesPerFile rejects only the oversized file and its siblings are still accepted", () => {
  // 取舍说明见 intake.ts 模块头：单文件大小逐文件拒绝（DSH 的图片语义是整批拒绝，
  // 但其通用文件本无本地上限；这里推广到通用文件时不连坐同批文件——B27 的验收标准）。
  const oversized = meta("big.png", 3 * 1024 * 1024, "image/png");
  const sibling = meta("small.txt", 10, "text/plain");
  const decision = intakeFiles([oversized, sibling], { maxBytesPerFile: 2 * 1024 * 1024 }, []);
  assert.deepEqual(decision.accepted, [sibling]);
  assert.deepEqual(decision.rejected, [{ name: "big.png", reason: "file_too_large" }]);
  // 恰好等于上限不违规（超限是严格大于）。
  assert.deepEqual(intakeFiles([meta("edge.bin", 2 * 1024 * 1024)], { maxBytesPerFile: 2 * 1024 * 1024 }, []).rejected, []);
});

test("IT04: maxBytesTotal counts existing assets and rejects the whole batch", () => {
  const existing = [meta("old.bin", 3 * 1024 * 1024)];
  const batch = [meta("a.bin", 1024), meta("b.bin", 1024)];
  // 已有 3MB + 新增 2KB > 3MB 总量：整批拒绝。
  const decision = intakeFiles(batch, { maxBytesTotal: 3 * 1024 * 1024 }, existing);
  assert.deepEqual(decision.accepted, []);
  assert.deepEqual(decision.rejected, [
    { name: "a.bin", reason: "total_too_large" },
    { name: "b.bin", reason: "total_too_large" },
  ]);
  // 总量只统计将通过准入的字节：已被逐文件（大小）拒绝的文件不连坐剩下的文件。
  const mixed = [meta("huge.bin", 4 * 1024 * 1024), meta("ok.bin", 1024)];
  const survivor = intakeFiles(mixed, { maxBytesPerFile: 2 * 1024 * 1024, maxBytesTotal: 2 * 1024 * 1024 }, []);
  assert.deepEqual(survivor.accepted, [mixed[1]]);
  assert.deepEqual(survivor.rejected, [{ name: "huge.bin", reason: "file_too_large" }]);
});

test("IT05: allowedMediaTypes matches exactly per file; absent means unlimited", () => {
  const image = meta("图.png", 1, "image/png");
  const text = meta("a.txt", 1, "text/plain");
  const decision = intakeFiles([image, text], { allowedMediaTypes: ["image/png", "IMAGE/JPEG"] }, []);
  assert.deepEqual(decision.accepted, [image]);
  assert.deepEqual(decision.rejected, [{ name: "a.txt", reason: "unsupported_type" }]);
  // 忽略大小写与首尾空白；缺省策略不限制类型。
  assert.deepEqual(intakeFiles([meta("x", 1, " Image/PNG ")], { allowedMediaTypes: ["image/png"] }, []).rejected, []);
  assert.deepEqual(intakeFiles([image, text], noPolicy, []).rejected, []);
  // 空类型（浏览器无法识别的文件）在显式白名单下按不支持处理。
  assert.deepEqual(intakeFiles([meta("noext", 1, "")], { allowedMediaTypes: ["image/png"] }, []).rejected, [
    { name: "noext", reason: "unsupported_type" },
  ]);
});

test("IT06: unsupported type and per-file size keep their own reasons when the total rejects the rest", () => {
  // 同一批里三类原因并存：类型与单文件大小保留原原因，其余文件按 total_too_large 记录。
  const wrongType = meta("x.exe", 1, "application/x-msdownload");
  const oversized = meta("big.bin", 900, "text/plain");
  const first = meta("ok.txt", 10, "text/plain");
  const second = meta("also.txt", 60, "text/plain");
  const decision = intakeFiles(
    [wrongType, oversized, first, second],
    { allowedMediaTypes: ["text/plain"], maxBytesPerFile: 100, maxBytesTotal: 50 },
    [],
  );
  // 10B + 60B = 70B > 50B：能通过逐文件检查的文件也因总量整批拒绝。
  assert.deepEqual(decision.accepted, []);
  assert.deepEqual(decision.rejected, [
    { name: "x.exe", reason: "unsupported_type" },
    { name: "big.bin", reason: "file_too_large" },
    { name: "ok.txt", reason: "total_too_large" },
    { name: "also.txt", reason: "total_too_large" },
  ]);
});

test("IT07: splitClipboard mirrors the DSH paste routing input (files vs text/plain)", () => {
  // 文件与纯文本可以同时为真：一次粘贴两者都处理。
  assert.deepEqual(
    splitClipboard([
      { kind: "string", type: "text/html" },
      { kind: "file", type: "image/png" },
      { kind: "string", type: "text/plain" },
    ]),
    { hasFiles: true, hasText: true },
  );
  // 只有 HTML 没有 text/plain：不算文本（DSH 消费纯文本而非 HTML）。
  assert.deepEqual(splitClipboard([{ kind: "string", type: "text/html" }]), { hasFiles: false, hasText: false });
  // 空剪贴板与纯文本。
  assert.deepEqual(splitClipboard([]), { hasFiles: false, hasText: false });
  assert.deepEqual(splitClipboard([{ kind: "string", type: "text/plain" }]), { hasFiles: false, hasText: true });
  assert.deepEqual(splitClipboard([{ kind: "file", type: "image/png" }]), { hasFiles: true, hasText: false });
});

test("IT08: formatBytes renders 1024-based sizes with one decimal above the byte range", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2 MB");
  assert.equal(formatBytes(3 * 1024 * 1024 + 512 * 1024), "3.5 MB");
  // 非法输入返回空串（宿主拼文案时直接跳过），不抛错。
  assert.equal(formatBytes(-1), "");
  assert.equal(formatBytes(Number.NaN), "");
});
