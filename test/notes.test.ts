import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { NoteStore, keyFor, newManualId, type NoteDoc } from "../src/gitnotes.ts";
import { importFromCache } from "../src/importer.ts";
import { RepoNotes, locate } from "../src/notes.ts";
import type { PullRequest } from "../src/types.ts";

// A bare repo acts as the shared remote; clones A and B and a worktree of A act as separate checkouts.
const base = mkdtempSync(join(tmpdir(), "code-notes-test-"));
const remote = join(base, "remote.git"), seed = join(base, "seed"), a = join(base, "a"), b = join(base, "b"), wt = join(base, "a-worktree");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const cli = (cwd: string, ...args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "..", "src", "cli.ts"), ...args, "--cwd", cwd], { encoding: "utf8" });
const fileLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);

function configure(dir: string, name: string) {
  git(dir, "config", "user.name", name);
  git(dir, "config", "user.email", `${name}@example.com`);
}

function manualNote(store: NoteStore, path: string, start: number, end: number, body: string): string {
  const id = newManualId(), now = new Date().toISOString();
  const lines = readFileSync(join(store.root, path), "utf8").split(/\r?\n/);
  store.put(keyFor(id), "test: add", () => ({
    schema: 1, id, source: "manual", path,
    anchor: { commit: git(store.root, "rev-parse", "HEAD"), startLine: start, endLine: end, text: lines[end - 1] },
    summary: null, comments: [{ author: store.author(), body, createdAt: now, source: "local" }],
    pr: null, createdAt: now, updatedAt: now, deleted: null, restoredAt: null,
  } satisfies NoteDoc));
  return keyFor(id);
}

before(() => {
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  configure(seed, "seed");
  writeFileSync(join(seed, "a.txt"), fileLines.join("\n") + "\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "initial");
  execFileSync("git", ["clone", "-q", "--bare", seed, remote]);
  execFileSync("git", ["clone", "-q", remote, a]);
  execFileSync("git", ["clone", "-q", remote, b]);
  configure(a, "alice");
  configure(b, "bob");
  git(a, "worktree", "add", "-q", "-b", "wt", wt);
});

after(() => rmSync(base, { recursive: true, force: true }));

let shared: string;

test("a note added in one clone is readable in another after sync", () => {
  shared = manualNote(new NoteStore(a), "a.txt", 3, 4, "Remember the edge case on these lines.");
  assert.match(cli(a, "show", "a.txt"), /Remember the edge case/);
  assert.match(cli(a, "sync"), /Pushed/);
  assert.match(cli(b, "sync"), /merged|Pushed/);
  const shown = cli(b, "show", "a.txt");
  assert.match(shown, /Remember the edge case/);
  assert.match(shown, new RegExp(`key: \`${shared}\``));
  assert.match(shown, /L3-4/);
});

test("push is rejected while the remote has notes that are not here; pull merges them", () => {
  const fromB = manualNote(new NoteStore(b), "a.txt", 2, 2, "Written in B.");
  cli(b, "push");
  const fromA = manualNote(new NoteStore(a), "a.txt", 5, 5, "Written in A.");
  assert.throws(() => cli(a, "push"), /Push rejected/);
  assert.match(cli(a, "pull"), /Pulled: 1 notes merged/);
  assert.match(cli(a, "push"), /Pushed/);
  cli(b, "pull");
  const shown = cli(b, "show", "a.txt");
  assert.match(shown, /Written in A/);
  assert.match(shown, /Written in B/);
  for (const key of [fromA, fromB]) cli(a, "delete", key, "--reason", "test cleanup");
  cli(a, "sync");
  cli(b, "sync");
});

test("a worktree sees notes from its main checkout without syncing", () => {
  const key = manualNote(new NoteStore(a), "a.txt", 1, 1, "Written in checkout A.");
  assert.match(cli(wt, "show", "a.txt"), /Written in checkout A/);
  cli(wt, "delete", key, "--reason", "test cleanup");
  assert.doesNotMatch(cli(a, "show", "a.txt"), /Written in checkout A/);
});

test("a deletion in one clone spreads to the other and wins over a concurrent edit", () => {
  cli(a, "comment", shared, "-m", "Still relevant?");
  cli(b, "delete", shared, "--reason", "fixed in the meantime", "--by", "agent:claude");
  cli(b, "sync");
  cli(a, "sync");
  cli(b, "sync");
  for (const dir of [a, b]) assert.doesNotMatch(cli(dir, "show", "a.txt"), /Remember the edge case/);
  const doc = new NoteStore(a).get(shared)!;
  assert.equal(doc.deleted?.by, "agent:claude");
  assert.ok(doc.comments.some((c) => c.body === "Still relevant?"), "the concurrent comment is kept in the tombstone");
});

test("restore brings a deleted note back everywhere", () => {
  cli(a, "restore", shared);
  cli(a, "sync");
  cli(b, "sync");
  assert.match(cli(b, "show", "a.txt"), /Remember the edge case/);
});

test("a re-import from GitHub does not bring back a deleted conversation", () => {
  const pr: PullRequest = {
    number: 7, title: "Add a.txt", url: "https://github.com/x/y/pull/7", state: "MERGED", author: "carol",
    updatedAt: "2026-01-01T00:00:00Z", mergedAt: "2026-01-01T00:00:00Z", headCommit: git(a, "rev-parse", "HEAD"),
    threads: [{
      id: "PRRT_test1", path: "a.txt", startLine: 5, line: 6, originalStartLine: 5, originalLine: 6, originalCommit: null,
      diffSide: "RIGHT", subjectType: "LINE", isResolved: true, isOutdated: false, diffHunk: "@@ -0,0 +1,6 @@\n+line 5\n+line 6",
      comments: [{ author: "carol", body: "We postpone this to TICKET-1.", createdAt: "2026-01-01T00:00:00Z", url: "https://github.com/x/y/pull/7#r1" }],
    }],
  };
  const store = new NoteStore(a);
  assert.equal(importFromCache(store, [pr]).added, 1);
  const key = keyFor("github-review-thread:PRRT_test1");
  assert.match(cli(a, "show", "a.txt"), /postpone this to TICKET-1/);
  store.softDelete(key, "agent:claude", "TICKET-1 is done");
  const again = importFromCache(store, [pr]);
  assert.deepEqual([again.added, again.skippedDeleted], [0, 1]);
  assert.doesNotMatch(cli(a, "show", "a.txt"), /postpone this to TICKET-1/);
  // The other clone imports the same conversation independently; the tombstone still wins after syncing.
  importFromCache(new NoteStore(b), [pr]);
  cli(a, "sync");
  cli(b, "sync");
  assert.doesNotMatch(cli(b, "show", "a.txt"), /postpone this to TICKET-1/);
});

test("notes follow renamed files and moved lines", () => {
  git(a, "mv", "a.txt", "b.txt");
  writeFileSync(join(a, "b.txt"), ["new 1", "new 2", ...fileLines].join("\n") + "\n");
  git(a, "commit", "-qam", "rename and insert two lines");
  const shown = cli(a, "show", "b.txt");
  assert.match(shown, /Remember the edge case/);
  assert.match(shown, /written when the file was a\.txt/);
  assert.match(shown, /L5-6/, "lines 3-4 moved down by two");
  assert.equal(RepoNotes.load(a).forFile("a.txt").length, 0);
});

test("locate keeps the stored range when the anchored text is unchanged", () => {
  assert.deepEqual(locate({ commit: null, startLine: 2, endLine: 3, text: "c" }, ["a", "b", "c"]), { start: 2, end: 3, match: "exact" });
  assert.deepEqual(locate({ commit: null, startLine: 2, endLine: 3, text: "c" }, ["x", "a", "b", "c"]), { start: 3, end: 4, match: "offset" });
});

test("notes use the repository's default remote unless overridden", () => {
  assert.equal(new NoteStore(seed).defaultRemote(), null, "a repo without remotes keeps notes local");
  assert.equal(new NoteStore(b).defaultRemote(), "origin", "a clone uses the remote of its branch");
  git(b, "remote", "add", "mirror", remote);
  git(b, "config", "code-notes.remote", "mirror");
  assert.equal(new NoteStore(b).defaultRemote(), "mirror", "git config code-notes.remote overrides it");
  git(b, "config", "--unset", "code-notes.remote");
  git(b, "remote", "remove", "mirror");
});
