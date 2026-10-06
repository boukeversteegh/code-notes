import { execFileSync } from "node:child_process";
import { diffArrays } from "diff";
import { type Located, locate } from "./anchor.ts";
import type { NoteDoc } from "./gitnotes.ts";

/**
 * Places notes in the current text of a file. When a note's anchor commit is available locally, its lines
 * are tracked exactly through a line diff between the file at that commit and the current text (the way
 * GitHub decides a comment is outdated). Otherwise the note is placed by its stored context, like `patch`.
 */

/** File contents at `commit:path` for each spec, read in one cat-file call; missing objects map to null. */
export function readAtCommits(root: string, specs: { commit: string; path: string }[]): Map<string, string[] | null> {
  const result = new Map<string, string[] | null>();
  const unique = [...new Set(specs.map((s) => `${s.commit}:${s.path}`))];
  if (unique.length === 0) return result;
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: unique.join("\n") + "\n", maxBuffer: 512 * 1024 * 1024 });
  let pos = 0;
  for (const spec of unique) {
    const headerEnd = out.indexOf(0x0a, pos);
    const header = out.toString("utf8", pos, headerEnd);
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
      result.set(spec, null);
      pos = headerEnd + 1;
      continue;
    }
    const size = Number(header.split(" ")[2]);
    result.set(spec, out.toString("utf8", headerEnd + 1, headerEnd + 1 + size).split(/\r?\n/));
    pos = headerEnd + 1 + size + 1;
  }
  return result;
}

/**
 * Maps lines `start`..`end` (1-based) of `oldLines` into `newLines`. Unchanged lines map exactly; if any
 * anchored line was changed or removed, the result is marked "changed" and covers the surviving lines,
 * or the place where the lines were replaced.
 */
type Changes = ReturnType<typeof diffArrays<string>>;

/** Line diff from an old version to the current text; undefined when it takes longer than `timeoutMs`. */
function lineDiff(oldLines: string[], newLines: string[], timeoutMs?: number): Changes | undefined {
  const norm = (l: string) => l.trimEnd();
  // A diff between very different versions of a large file can take long; give up after the timeout.
  return timeoutMs
    ? diffArrays(oldLines.map(norm), newLines.map(norm), { timeout: timeoutMs })
    : diffArrays(oldLines.map(norm), newLines.map(norm));
}

export function trackLines(oldLines: string[], newLines: string[], start: number, end: number, timeoutMs?: number): Located | null {
  const changes = lineDiff(oldLines, newLines, timeoutMs);
  return changes ? mapThroughDiff(changes, newLines.length, start, end) : null;
}

/** Maps old lines `start`..`end` through a line diff (see trackLines). */
function mapThroughDiff(changes: Changes, newLength: number, start: number, end: number): Located {
  const covered: number[] = []; // new lines (1-based) that now hold the anchored lines or their replacements
  let changed = false, replacedAt: number | null = null;
  let oldLine = 1, newLine = 1;
  for (let ci = 0; ci < changes.length; ci++) {
    const c = changes[ci], n = c.count ?? c.value.length;
    if (c.added) {
      newLine += n;
      continue;
    }
    let touched = false;
    for (let i = 0; i < n; i++, oldLine++) {
      if (oldLine < start || oldLine > end) continue;
      touched = true;
      if (c.removed) changed = true;
      else covered.push(newLine + i);
    }
    if (c.removed && touched) {
      replacedAt ??= newLine;
      // Lines added right after removed anchored lines are their replacement (an edit, not a deletion).
      const next = changes[ci + 1];
      if (next?.added) for (let i = 0; i < (next.count ?? next.value.length); i++) covered.push(newLine + i);
    }
    if (!c.removed) newLine += n;
  }
  if (covered.length === 0) {
    const at = Math.max(1, Math.min(replacedAt ?? start, newLength));
    return { start: at, end: at, match: "changed" };
  }
  return { start: Math.min(...covered), end: Math.max(...covered), match: changed ? "changed" : "tracked" };
}

/** Longest a single line diff may take before placement falls back to matching stored context. */
const DIFF_TIMEOUT_MS = 200;

/** Places each note in `currentLines`, using git tracking where the anchor commit is available. */
export function placeNotes(root: string, docs: NoteDoc[], currentLines: string[]): (Located | null)[] {
  const trackable = docs.filter((d) => d.anchor.commit && d.anchor.endLine != null);
  const files = readAtCommits(root, trackable.map((d) => ({ commit: d.anchor.commit!, path: d.path })));
  // One diff per version of the file, shared by all notes anchored to it.
  const diffs = new Map<string, Changes | undefined>();
  return docs.map((d) => {
    if (d.anchor.endLine == null) return null;
    const spec = `${d.anchor.commit}:${d.path}`;
    const old = d.anchor.commit ? files.get(spec) : null;
    if (old && !diffs.has(spec)) diffs.set(spec, lineDiff(old, currentLines, DIFF_TIMEOUT_MS));
    const changes = old ? diffs.get(spec) : undefined;
    const tracked = changes ? mapThroughDiff(changes, currentLines.length, d.anchor.startLine ?? d.anchor.endLine, d.anchor.endLine) : null;
    return tracked ?? locate(d.anchor, currentLines);
  });
}
