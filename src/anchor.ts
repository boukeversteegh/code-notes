/**
 * Anchoring notes to lines the way `patch` applies hunks: a note stores its lines plus a few lines of
 * context, and is placed by searching the current file for that block, nearest to the stored position
 * first, dropping outer context lines when the exact block is gone ("fuzz"), and finally by best partial
 * match. No git history is needed, so anchors work in any clone.
 */

export const CONTEXT_LINES = 3;
const MAX_ANCHORED_LINES = 50;

export interface NoteAnchor {
  /** Commit the line numbers refer to, when known. */
  commit: string | null;
  startLine: number | null;
  endLine: number | null;
  /** Text of the last anchored line. Superseded by `lines`; kept for notes written before context existed. */
  text: string | null;
  /** Up to CONTEXT_LINES lines before the anchored lines. */
  before?: string[];
  /** The anchored lines themselves (capped at MAX_ANCHORED_LINES). */
  lines?: string[];
  /** Up to CONTEXT_LINES lines after the anchored lines. */
  after?: string[];
}

export type MatchKind =
  | "tracked" // followed through git history; the lines are unchanged since the note was written
  | "changed" // followed through git history; the lines were edited since the note was written
  | "exact" // the whole block is at the stored position
  | "offset" // the whole block, elsewhere in the file
  | "fuzz" // the anchored lines with less (or no) surrounding context
  | "approximate" // best partial match; the anchored lines were edited
  | "unmatched"; // nothing similar found; the stored line numbers are used

export interface Located {
  start: number;
  end: number;
  match: MatchKind;
  /** For "fuzz": context lines dropped on each side. */
  fuzz?: number;
}

/** Builds an anchor for lines `start`..`end` (1-based, inclusive) of `fileLines`. */
export function buildAnchor(fileLines: string[], start: number, end: number, commit: string | null): NoteAnchor {
  const lines = fileLines.slice(start - 1, end);
  return {
    commit, startLine: start, endLine: end, text: fileLines[end - 1] ?? null,
    before: fileLines.slice(Math.max(0, start - 1 - CONTEXT_LINES), start - 1),
    lines: lines.length > MAX_ANCHORED_LINES ? [...lines.slice(0, MAX_ANCHORED_LINES / 2), ...lines.slice(-MAX_ANCHORED_LINES / 2)] : lines,
    after: fileLines.slice(end, end + CONTEXT_LINES),
  };
}

/**
 * Builds an anchor from a GitHub review comment's diff hunk, which ends at the commented line.
 * RIGHT-side comments are on the new version (context and added lines); LEFT-side on the old version.
 */
export function anchorFromHunk(diffHunk: string, start: number, end: number, side: "LEFT" | "RIGHT", commit: string | null): NoteAnchor {
  const keep = side === "RIGHT" ? /^[ +]/ : /^[ -]/;
  const fileSide = diffHunk.split(/\r?\n/).filter((l) => !l.startsWith("@@") && keep.test(l)).map((l) => l.slice(1));
  const count = end - start + 1;
  const lines = fileSide.slice(-count);
  return {
    commit, startLine: start, endLine: end, text: lines.at(-1) ?? null,
    before: fileSide.slice(Math.max(0, fileSide.length - count - CONTEXT_LINES), fileSide.length - count),
    lines,
    after: [],
  };
}

const norm = (line: string) => line.trim().replace(/\s+/g, " ");

/** A pattern is only trusted on its own if it has some substance, not just braces or blank lines. */
const significant = (lines: string[]) => lines.some((l) => norm(l).replace(/[{}()[\];,]/g, "").length >= 4);

/** 0-based start positions where `pattern` matches `file` exactly (after normalization), nearest to `expected` first. */
function exactMatches(file: string[], pattern: string[], expected: number): number[] {
  const hits: number[] = [];
  for (let p = 0; p + pattern.length <= file.length; p++) {
    if (pattern.every((l, i) => file[p + i] === l)) hits.push(p);
  }
  return hits.sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected));
}

/** Places `anchor` in `fileLines`. Returns null only for whole-file notes (no line range). */
export function locate(anchor: NoteAnchor, fileLines: string[]): Located | null {
  if (anchor.endLine == null) return null;
  const storedEnd = anchor.endLine, storedStart = anchor.startLine ?? storedEnd;
  const span = storedEnd - storedStart;
  const fallback: Located = { start: storedStart, end: storedEnd, match: "unmatched" };
  const file = fileLines.map(norm);

  // Notes written before context was stored only have the text of their last line.
  if (!anchor.lines?.length) {
    const want = anchor.text ? norm(anchor.text) : "";
    if (!want) return { ...fallback, match: "exact" };
    if (file[storedEnd - 1] === want) return { start: storedStart, end: storedEnd, match: "exact" };
    const [hit] = exactMatches(file, [want], storedEnd - 1);
    return hit == null ? fallback : { start: hit + 1 - span, end: hit + 1, match: "offset" };
  }

  const before = (anchor.before ?? []).map(norm), lines = anchor.lines.map(norm), after = (anchor.after ?? []).map(norm);
  // Where the anchored lines would start if nothing moved (0-based).
  const expected = storedStart - 1;
  const result = (lineStart: number, match: MatchKind, fuzz?: number): Located =>
    ({ start: lineStart + 1, end: lineStart + 1 + span, match, ...(fuzz ? { fuzz } : {}) });

  // Exact block, then with fewer context lines: like patch's offset search and fuzz factor.
  const maxFuzz = Math.max(before.length, after.length);
  for (let fuzz = 0; fuzz <= maxFuzz; fuzz++) {
    const b = before.slice(Math.min(fuzz, before.length)), a = after.slice(0, Math.max(0, after.length - fuzz));
    const pattern = [...b, ...lines, ...a];
    if (!significant(pattern)) continue;
    const [hit] = exactMatches(file, pattern, expected - b.length);
    if (hit != null) {
      const lineStart = hit + b.length;
      return result(lineStart, fuzz === 0 ? (lineStart === expected ? "exact" : "offset") : "fuzz", fuzz);
    }
  }

  return approximate(file, before, lines, after, expected, span) ?? fallback;
}

/**
 * Best partial match: slides a window over the file and scores it by a weighted longest common
 * subsequence with the anchor block, where similar lines (edited, not rewritten) earn partial credit and
 * anchored lines count double. The anchored lines' new position comes from the alignment. Requires 60% of
 * the weighted block to match, including at least one substantive anchored line.
 */
function approximate(file: string[], before: string[], lines: string[], after: string[], expected: number, span: number): Located | null {
  const pattern = [...before, ...lines, ...after];
  const isAnchored = (i: number) => i >= before.length && i < before.length + lines.length;
  const weight = pattern.map((l, i) => (isAnchored(i) ? 2 : 1) * (significant([l]) ? 1 : 0.25));
  const total = weight.reduce((a, b) => a + b, 0);
  // Similarity of every pattern line to every file line, computed once and shared by all windows.
  const grams = file.map(bigrams), patternGrams = pattern.map(bigrams);
  const sim = pattern.map((l, i) => Float32Array.from(file, (f, j) => similarity(l, f, patternGrams[i], grams[j])));
  const windowSize = pattern.length + 5; // allow a few inserted lines inside the block
  let best: { score: number; distance: number; start: number } | null = null;
  for (let p = 0; p < file.length; p++) {
    const w = Math.min(windowSize, file.length - p);
    const { score, aligned } = lcs(pattern.length, w, (i, j) => sim[i][p + j], weight);
    if (score / total < 0.6) continue;
    const anchored = aligned.filter(([pi]) => isAnchored(pi) && significant([pattern[pi]]));
    if (anchored.length === 0) continue;
    // Place the anchored range by its first aligned substantive line, keeping the stored span.
    const [firstP, firstW] = anchored[0];
    const startLine = p + firstW - (firstP - before.length);
    const distance = Math.abs(startLine - expected);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && distance < best.distance)) {
      best = { score, distance, start: startLine };
    }
  }
  if (!best) return null;
  // The first aligned line may not be the first anchored line; keep the range inside the file.
  const start = Math.min(Math.max(best.start, 0), Math.max(file.length - 1 - span, 0));
  return { start: start + 1, end: Math.min(start + 1 + span, file.length), match: "approximate" };
}

function bigrams(line: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < line.length - 1; i++) {
    const g = line.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 1 for equal lines, otherwise the Dice coefficient of character bigrams when it is at least 0.6, else 0. */
function similarity(a: string, b: string, ga: Map<string, number>, gb: Map<string, number>): number {
  if (a === b) return a === "" ? 0 : 1;
  if (!a || !b || Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.5) return 0;
  let common = 0;
  for (const [g, n] of ga) common += Math.min(n, gb.get(g) ?? 0);
  const dice = (2 * common) / (a.length - 1 + b.length - 1);
  return dice >= 0.6 ? dice : 0;
}

/** Weighted longest common subsequence where pairs score weight × similarity, with the aligned index pairs. */
function lcs(n: number, m: number, sim: (i: number, j: number) => number, weight: number[]): { score: number; aligned: [number, number][] } {
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = sim(i, j);
      dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], s > 0 ? weight[i] * s + dp[i + 1][j + 1] : 0);
    }
  }
  const aligned: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    const s = sim(i, j);
    if (s > 0 && dp[i][j] === weight[i] * s + dp[i + 1][j + 1]) aligned.push([i++, j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { score: dp[0][0], aligned };
}
