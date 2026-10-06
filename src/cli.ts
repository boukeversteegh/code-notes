import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Cache } from "./cache.ts";
import { buildAnchor } from "./anchor.ts";
import { formatFileNotes } from "./format.ts";
import { NoteStore, keyFor, newManualId } from "./gitnotes.ts";
import { importFromCache } from "./importer.ts";
import { RepoNotes } from "./notes.ts";
import { placeNotes } from "./tracking.ts";
import { detectRepo, gitRoot, toRepoPath } from "./repo.ts";
import { githubDeletionReply, setThreadResolved } from "./github.ts";
import { ThreadStates } from "./thread-states.ts";
import { fetchPrsIntoCache } from "./fetch-prs.ts";

const USAGE = `Usage:
  Notes (stored in git notes on refs/notes/code-notes of the repo at --cwd):
  code-notes show    <file> [--lines A-B] [--json]
  code-notes add     <file> --lines A-B -m TEXT
  code-notes comment <key> -m TEXT
  code-notes delete  <key> --reason TEXT [--by NAME] [--resolve-on-github]
  code-notes restore <key>
  code-notes pull    [--remote NAME]
  code-notes push    [--remote NAME]
  code-notes sync    [--remote NAME]

  GitHub import:
  code-notes import  [--repo OWNER/NAME] [--limit N] [--full] [--no-fetch]
  code-notes stats   [--top N]

All commands accept --cwd DIR (default: current directory).

show       Print the live notes on <file>, including notes written under earlier names of the file.
           Each note shows its key, which delete/comment/restore take.
add        Create a note on lines A-B of <file>, anchored to HEAD.
comment    Append a comment to a note.
delete     Soft-delete a note: it disappears everywhere after the next sync and an import never brings it back.
           With --resolve-on-github, the reason is also posted on the note's open GitHub conversation and it is resolved.
restore    Undo a delete.
pull       Fetch the notes of the remote set in \`git config code-notes.remote\` (or --remote) and merge them.
push       Push the local notes to that remote. Rejected when the remote has notes that are not here yet.
sync       Pull, then push.
import     Fetch review conversations of closed and merged PRs from GitHub and write them into notes. Deciding
           relevance is left to whoever reads the notes: they delete what no longer matters. Conversations whose
           note was deleted are skipped. --no-fetch imports what was fetched before (cache in ~/.cache/code-notes).
stats      List the files with the most fetched review conversations.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: "string", default: process.cwd() },
    repo: { type: "string" },
    remote: { type: "string" },
    limit: { type: "string" },
    full: { type: "boolean", default: false },
    "no-fetch": { type: "boolean", default: false },
    lines: { type: "string" },
    message: { type: "string", short: "m" },
    reason: { type: "string" },
    "resolve-on-github": { type: "boolean", default: false },
    by: { type: "string" },
    all: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    top: { type: "string", default: "20" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, arg] = positionals;
if (values.help || !command) {
  console.log(USAGE);
  process.exit(0);
}

const root = () => gitRoot(values.cwd);
const store = () => new NoteStore(root());

/** GitHub repo for the cache: --repo, then `git config code-notes.github`, then the origin remote. */
function githubRepo(): string {
  if (values.repo) return values.repo;
  const configured = spawnSync("git", ["config", "--get", "code-notes.github"], { cwd: values.cwd, encoding: "utf8" }).stdout.trim();
  return configured || detectRepo(values.cwd);
}
let cacheInstance: Cache | undefined;
const cache = () => (cacheInstance ??= new Cache(githubRepo()));

function parseRange(spec: string): { start: number; end: number } {
  const [a, b] = spec.split("-").map(Number);
  return { start: a, end: b ?? a };
}

async function show(): Promise<void> {
  if (!arg) throw new Error("show requires a <file> argument");
  const path = toRepoPath(arg, values.cwd);
  const absolute = join(root(), path);
  const lines = existsSync(absolute) ? readFileSync(absolute, "utf8").split(/\r?\n/) : [];
  const fileNotes = RepoNotes.load(root()).forFile(path);
  const placed = placeNotes(root(), fileNotes.map((n) => n.doc), lines);
  // Whether GitHub conversations are resolved is looked up now (cached for a few minutes), not stored in notes.
  const threadIds = fileNotes.flatMap((n) => (n.doc.github ? [n.doc.github.threadId] : []));
  const states = threadIds.length ? await new ThreadStates(root()).refresh(threadIds).catch(() => new Map<string, boolean>()) : new Map<string, boolean>();
  let notes = fileNotes.map((note, i) => ({ note, range: placed[i], githubResolved: note.doc.github ? states.get(note.doc.github.threadId) : undefined }));
  if (values.lines) {
    const want = parseRange(values.lines);
    notes = notes.filter(({ range }) => !range || (range.start <= want.end && range.end >= want.start));
  }
  console.log(values.json ? JSON.stringify(notes, null, 2) : formatFileNotes(path, notes));
}

function add(): void {
  if (!arg || !values.lines || !values.message) throw new Error("add requires <file>, --lines and -m");
  const s = store();
  const path = toRepoPath(arg, values.cwd);
  const range = parseRange(values.lines);
  const lines = readFileSync(join(s.root, path), "utf8").split(/\r?\n/);
  const id = newManualId();
  const now = new Date().toISOString();
  const author = values.by ?? s.author();
  s.put(keyFor(id), `code-notes: add note on ${path}`, () => ({
    schema: 1, id, source: "manual", path,
    anchor: buildAnchor(lines, range.start, range.end, s.git(["rev-parse", "HEAD"]).trim()),
    summary: null, comments: [{ author, body: values.message!, createdAt: now, source: "local" }],
    pr: null, createdAt: now, updatedAt: now, deleted: null, restoredAt: null,
  }));
  console.log(`Added note ${keyFor(id)} on ${path}:${range.start}-${range.end}.`);
}

function requireKey(): string {
  if (!arg || !/^[0-9a-f]{40}$/.test(arg)) throw new Error(`${command} requires a note key (40 hex characters, shown by \`code-notes show\`)`);
  return arg;
}

async function del(): Promise<void> {
  const key = requireKey();
  if (!values.reason) throw new Error("delete requires --reason");
  const s = store();
  const doc = s.softDelete(key, values.by ?? s.author(), values.reason);
  if (!doc) {
    console.log(`No live note ${key}; nothing deleted.`);
    return;
  }
  console.log(`Deleted note ${key}.`);
  // With --resolve-on-github, the reason is posted on the note's GitHub conversation if it is still open, which is then resolved.
  if (values["resolve-on-github"] && doc.github) {
    const states = new ThreadStates(root(), 0); // always ask GitHub for the current state
    const resolved = (await states.refresh([doc.github.threadId])).get(doc.github.threadId);
    if (resolved === false) {
      states.set(doc.github.threadId, await setThreadResolved(doc.github.threadId, true, githubDeletionReply(values.reason)));
      console.log(`Posted the reason on ${doc.github.url} and resolved the conversation.`);
    } else if (resolved) {
      console.log("The GitHub conversation was already resolved; nothing posted.");
    }
  }
}

function restore(): void {
  const key = requireKey();
  console.log(store().restore(key) ? `Restored note ${key}.` : `Note ${key} is not deleted; nothing restored.`);
}

function comment(): void {
  const key = requireKey();
  if (!values.message) throw new Error("comment requires -m");
  const s = store();
  const doc = s.addComment(key, { author: values.by ?? s.author(), body: values.message, createdAt: new Date().toISOString() });
  console.log(doc ? `Commented on note ${key}.` : `No note ${key}.`);
}

function pull(): void {
  const r = store().pull(values.remote);
  console.log(r.fetched ? `Pulled: ${r.merged} notes merged from the remote.` : "The remote has no notes yet.");
}

function push(): void {
  const r = store().push(values.remote);
  if (r === "rejected") throw new Error("Push rejected: the remote has notes that are not here yet. Run `code-notes pull` or `code-notes sync` first.");
  console.log(r === "pushed" ? "Pushed." : "No notes to push.");
}

function syncNotes(): void {
  const r = store().sync(values.remote);
  console.log(`${r.fetched ? `Pulled: ${r.merged} notes merged from the remote.` : "The remote has no notes yet."} ${r.pushed ? "Pushed." : "No notes to push."}`);
}

async function importNotes(): Promise<void> {
  if (!values["no-fetch"]) {
    // Without --limit every PR is considered; a re-run stops at the first PR unchanged since the last fetch.
    await fetchPrsIntoCache(cache(), { limit: values.limit ? Number(values.limit) : Infinity, full: values.full, log: (msg) => console.error(msg) });
  }
  const result = importFromCache(store(), cache().readPrs());
  console.log(`Imported into ${root()}: ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged, ` +
    `${result.skippedDeleted} skipped because deleted.`);
}

function stats(): void {
  const index = cache().readIndex();
  if (!index) throw new Error(`No index for ${cache().repo}; run \`code-notes sync\` first.`);
  const rows = Object.entries(index.files)
    .map(([path, threads]) => ({ path, threads: threads.length, prs: new Set(threads.map((t) => t.pr.number)).size }))
    .sort((a, b) => b.threads - a.threads)
    .slice(0, Number(values.top));
  for (const r of rows) console.log(`${String(r.threads).padStart(4)} threads  ${String(r.prs).padStart(3)} PRs  ${r.path}`);
}

const commands: Record<string, () => void | Promise<void>> = {
  show, add, comment, delete: del, restore, pull, push, sync: syncNotes, import: importNotes, stats,
};

try {
  const run = commands[command];
  if (!run) throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  await run();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
