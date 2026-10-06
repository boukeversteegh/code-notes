import type { Located } from "./anchor.ts";
import type { NoteDoc } from "./gitnotes.ts";
import type { FileNote } from "./notes.ts";
import type { FileThread } from "./types.ts";

/** Line range a GitHub thread refers to, preferring the PR head position over the original one. */
export function threadRange(t: Pick<FileThread, "line" | "startLine" | "originalLine" | "originalStartLine">): { start: number; end: number } | null {
  const end = t.line ?? t.originalLine;
  if (end == null) return null;
  const start = (t.line != null ? t.startLine : t.originalStartLine) ?? end;
  return { start, end };
}

/** "Name <email>" (git authorship) -> "Name". */
export const withoutEmail = (author: string) => author.replace(/\s*<[^>]*>$/, "");

const indent = (text: string, prefix: string) =>
  text.trim().split(/\r?\n/).map((l) => prefix + l).join("\n");

export function describeLines(range: { start: number; end: number } | null): string {
  if (!range) return "whole file";
  return range.start === range.end ? `L${range.start}` : `L${range.start}-${range.end}`;
}

/** How a note was placed, for display: empty when it sits where it was written. */
export function describeMatch(located: Located | null, stored: { startLine: number | null }): string {
  if (!located) return "";
  switch (located.match) {
    case "exact": case "tracked": return "";
    case "changed": return "code changed since";
    case "offset": {
      const moved = located.start - (stored.startLine ?? located.start);
      return moved === 0 ? "" : `moved ${moved > 0 ? "+" : ""}${moved}`;
    }
    case "fuzz": return "surrounding code changed";
    case "approximate": return "lines changed since";
    case "unmatched": return "not found; original line numbers";
  }
}

/**
 * The code the note was written about, as a fenced block, when the current lines differ from it
 * (like GitHub shows the original diff on an outdated comment). Null when the lines are unchanged.
 */
export function originalCode(doc: NoteDoc, located: Located | null): string | null {
  if (!located || !doc.anchor.lines?.length) return null;
  if (located.match === "exact" || located.match === "tracked" || located.match === "offset") return null;
  const lang = doc.path.split(".").pop() ?? "";
  const code = [...(doc.anchor.before ?? []), ...doc.anchor.lines].map((l) => l.replace(/\r$/, "")).join("\n");
  return ["Code when this was written:", "```" + lang, code, "```"].join("\n");
}

/** Markdown for one note. `range` is where the note sits in the current file, if known. */
export function formatNote(n: FileNote, range: Located | null, githubResolved?: boolean): string {
  const { doc } = n;
  const origin = doc.pr ? `PR #${doc.pr.number} ${doc.pr.title}` : `note by ${withoutEmail(doc.comments[0]?.author ?? "unknown")}`;
  const match = describeMatch(range, doc.anchor);
  const out = [`### ${describeLines(range)}${match ? ` (${match})` : ""} · ${origin}`, `key: \`${n.key}\``];
  if (doc.pr) {
    const status = githubResolved === undefined ? "" : githubResolved ? " (resolved on GitHub)" : " (open on GitHub)";
    out.push(`${doc.github?.url ?? doc.comments[0]?.url ?? doc.pr.url}${status}`);
  }
  if (n.originalPath) out.push(`(written when the file was ${n.originalPath})`);
  if (doc.summary) out.push(`> ${doc.summary}`);
  const original = originalCode(doc, range);
  if (original) out.push(original);
  for (const comment of doc.comments) {
    out.push(`- **@${withoutEmail(comment.author)}** (${comment.createdAt.slice(0, 10)}):`, indent(comment.body, "  "));
  }
  return out.join("\n");
}

export function formatFileNotes(path: string, notes: { note: FileNote; range: Located | null; githubResolved?: boolean }[]): string {
  if (notes.length === 0) return `No code notes for ${path}.`;
  const header = `## Code notes for ${path} (${notes.length})\nNotes that are no longer relevant can be removed with \`code-notes delete <key> --reason "..."\`.`;
  return [header, ...notes.map(({ note, range, githubResolved }) => formatNote(note, range, githubResolved))].join("\n\n");
}
