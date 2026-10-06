import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorFromHunk, buildAnchor, locate } from "../src/anchor.ts";
import { trackLines } from "../src/tracking.ts";

const original = [
  "import x from 'x';",
  "",
  "function retryCount(config) {",
  "  if (!config) return 3;",
  "  const value = config.retries ?? 3;",
  "  return Math.max(1, value);",
  "}",
  "",
  "function other() {",
  "  return 42;",
  "}",
];
// The note is on `const value = ...` and `return Math.max(...)` (lines 5-6).
const anchor = buildAnchor(original, 5, 6, "abc");

test("unchanged file: exact match at the stored lines", () => {
  assert.deepEqual(locate(anchor, original), { start: 5, end: 6, match: "exact" });
});

test("lines inserted above: the block is found at its new offset", () => {
  const file = ["// header", "// more header", ...original];
  assert.deepEqual(locate(anchor, file), { start: 7, end: 8, match: "offset" });
});

test("surrounding code changed: fuzz drops context lines", () => {
  const file = [...original];
  file[3] = "  if (config == null) return 5;"; // the line right before the anchored lines
  const r = locate(anchor, file)!;
  assert.deepEqual([r.start, r.end, r.match], [5, 6, "fuzz"]);
});

test("anchored lines edited: approximate match still lands on the right lines", () => {
  const file = ["// header", ...original];
  file[6] = "  return Math.max(1, Math.min(value, 10));"; // second anchored line changed, now at line 7
  const r = locate(anchor, file)!;
  assert.deepEqual([r.start, r.end, r.match], [6, 7, "approximate"]);
});

test("duplicate code: the occurrence nearest to the stored position wins", () => {
  const block = original.slice(2, 7);
  const file = [...block, "", ...original, "", ...block];
  const r = locate(anchor, file)!;
  assert.equal(r.match, "offset");
  assert.deepEqual([r.start, r.end], [5 + block.length + 1, 6 + block.length + 1]);
});

test("block removed: falls back to the stored line numbers", () => {
  const file = ["completely", "different", "content", "here", "now", "and", "more"];
  assert.deepEqual(locate(anchor, file), { start: 5, end: 6, match: "unmatched" });
});

test("whitespace and indentation changes do not matter", () => {
  const file = original.map((l) => `    ${l.trim()}`);
  assert.equal(locate(anchor, file)!.match, "exact");
});

test("anchors from a GitHub diff hunk use the new side and the lines before the comment", () => {
  const hunk = ["@@ -1,4 +1,5 @@", " function retryCount(config) {", "-  if (!config) return 0;", "+  if (!config) return 3;", "+  const value = config.retries ?? 3;", "   return Math.max(1, value);"].join("\n");
  const a = anchorFromHunk(hunk, 5, 6, "RIGHT", "abc");
  assert.deepEqual(a.lines, ["  const value = config.retries ?? 3;", "  return Math.max(1, value);"]);
  assert.deepEqual(a.before, ["function retryCount(config) {", "  if (!config) return 3;"]);
  assert.deepEqual(locate(a, ["// added", ...original]), { start: 6, end: 7, match: "offset" });
});

test("notes from before context was stored still locate by their last line's text", () => {
  const legacy = { commit: null, startLine: 5, endLine: 6, text: "  return Math.max(1, value);" };
  assert.deepEqual(locate(legacy, ["x", ...original]), { start: 6, end: 7, match: "offset" });
});

test("git tracking: lines inserted above shift the note exactly", () => {
  assert.deepEqual(trackLines(original, ["// a", "// b", ...original], 5, 6), { start: 7, end: 8, match: "tracked" });
});

test("git tracking: an edited anchored line marks the note as changed and keeps covering it", () => {
  const file = [...original];
  file[5] = "  return Math.max(2, value);";
  assert.deepEqual(trackLines(original, file, 5, 6), { start: 5, end: 6, match: "changed" });
});

test("git tracking: removed lines place the note where they were", () => {
  const file = [...original.slice(0, 4), ...original.slice(6)];
  assert.deepEqual(trackLines(original, file, 5, 6), { start: 5, end: 5, match: "changed" });
});
