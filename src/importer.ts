import { anchorFromHunk } from "./anchor.ts";
import { threadRange } from "./format.ts";
import { type NoteComment, type NoteDoc, type NoteStore, keyFor } from "./gitnotes.ts";
import type { PullRequest, ReviewThread } from "./types.ts";

export interface ImportResult {
  added: number;
  updated: number;
  unchanged: number;
  /** Conversations whose note was deleted earlier; they stay deleted. */
  skippedDeleted: number;
}

function threadAnchor(thread: ReviewThread, pr: PullRequest) {
  const range = threadRange(thread);
  const commit = thread.line != null ? pr.headCommit : thread.originalCommit;
  if (!range) return { commit, startLine: null, endLine: null, text: null };
  return anchorFromHunk(thread.diffHunk, range.start, range.end, thread.diffSide, commit);
}

/** The note document for a GitHub review thread, as the import writes it. */
export function threadNote(thread: ReviewThread, pr: PullRequest, now = new Date().toISOString()): { key: string; doc: NoteDoc } {
  return {
    key: keyFor(`github-review-thread:${thread.id}`),
    doc: {
      schema: 1,
      id: `github-review-thread:${thread.id}`,
      source: "github-review",
      path: thread.path,
      anchor: threadAnchor(thread, pr),
      summary: null,
      comments: githubComments(thread),
      pr: { number: pr.number, title: pr.title, url: pr.url, state: pr.state },
      github: { threadId: thread.id, url: thread.comments[0]?.url ?? pr.url },
      createdAt: thread.comments[0]?.createdAt ?? now,
      updatedAt: now,
      deleted: null,
      restoredAt: null,
    },
  };
}

const githubComments = (t: ReviewThread): NoteComment[] =>
  t.comments.map((c) => ({ author: c.author, body: c.body, createdAt: c.createdAt, url: c.url, source: "github" }));

/** The parts of a note that an import may change; used to detect real changes. */
const importedContent = (d: NoteDoc) => JSON.stringify([d.comments, d.pr, d.anchor, d.github]);

/**
 * Imports every cached GitHub review conversation of closed and merged PRs into git notes. Whether a note
 * is still relevant is left to the developers and agents who read it: they delete it. Deleted notes are
 * never brought back, and comments added locally to an imported note are kept.
 */
export function importFromCache(store: NoteStore, prs: PullRequest[]): ImportResult {
  const result: ImportResult = { added: 0, updated: 0, unchanged: 0, skippedDeleted: 0 };
  const now = new Date().toISOString();
  store.update(`code-notes: import GitHub review conversations`, (docs) => {
    docs.load();
    let changed = false;
    for (const pr of prs) {
      // Reviews on open PRs are still in progress and visible on GitHub.
      if (pr.state === "OPEN") continue;
      for (const thread of pr.threads) {
        const key = keyFor(`github-review-thread:${thread.id}`);
        const existing = docs.get(key);
        if (existing?.deleted) {
          result.skippedDeleted++;
          continue;
        }
        const fields = {
          comments: [...githubComments(thread), ...(existing?.comments.filter((x) => x.source === "local") ?? [])],
          pr: { number: pr.number, title: pr.title, url: pr.url, state: pr.state },
          github: { threadId: thread.id, url: thread.comments[0]?.url ?? pr.url },
        };
        if (existing) {
          // Notes imported before anchors had context get the context now; their position is unchanged.
          const anchor = existing.anchor.lines ? existing.anchor : threadAnchor(thread, pr);
          const next: NoteDoc = { ...existing, ...fields, anchor };
          if (importedContent(next) === importedContent(existing)) {
            result.unchanged++;
            continue;
          }
          docs.set(key, { ...next, updatedAt: now });
          result.updated++;
        } else {
          docs.set(key, {
              schema: 1,
              id: `github-review-thread:${thread.id}`,
              source: "github-review",
              path: thread.path,
              anchor: threadAnchor(thread, pr),
              summary: null,
              ...fields,
              createdAt: thread.comments[0]?.createdAt ?? now,
              updatedAt: now,
              deleted: null,
              restoredAt: null,
          });
          result.added++;
        }
        changed = true;
      }
    }
    return changed;
  });
  return result;
}
