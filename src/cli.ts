import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Cache } from "./cache.ts";
import { CATEGORIES, type Classification, type ThreadInput, classifyWithClaude, prefilter, threadHash } from "./classify.ts";
import { buildAnchor } from "./anchor.ts";
import { formatFileNotes } from "./format.ts";
import { NoteStore, keyFor, newManualId } from "./gitnotes.ts";
import { importFromCache } from "./importer.ts";
import { RepoNotes } from "./notes.ts";
import { placeNotes } from "./tracking.ts";
import { detectRepo, gitRoot, toRepoPath } from "./repo.ts";
import { SYSTEM_ONE_CLASSIFIERS, classifyWithSystemOne } from "./systemone.ts";
import { githubDeletionReply, setThreadResolved } from "./github.ts";
import { sync } from "./sync.ts";

const USAGE = `Usage:
  Notes (stored in git notes on refs/notes/code-notes of the repo at --cwd):
  code-notes show    <file> [--lines A-B] [--json]
  code-notes add     <file> --lines A-B -m TEXT
  code-notes comment <key> -m TEXT
  code-notes delete  <key> --reason TEXT [--by NAME] [--resolve-on-github]
  code-notes restore <key>
  code-notes sync-notes [--remote NAME]

  GitHub import (cache in ~/.cache/code-notes):
  code-notes sync     [--repo OWNER/NAME] [--limit N] [--full]
  code-notes classify [--classifier haiku|jev|mercury|jev-v2|mercury-v2] [--sample N] [--seed S] [--batch 10] [--concurrency 4] [--threshold 0.5]
  code-notes report   [--classifier NAME]
  code-notes stats    [--top N]
  code-notes import

All commands accept --cwd DIR (default: current directory).

show       Print the live notes on <file>, including notes written under earlier names of the file.
           Each note shows its key, which delete/comment/restore take.
add        Create a note on lines A-B of <file>, anchored to HEAD.
comment    Append a comment to a note.
delete     Soft-delete a note: it disappears everywhere after the next sync-notes and an import never brings it back.
           With --resolve-on-github, the reason is also posted on the note's open GitHub conversation and it is resolved.
restore    Undo a delete.
sync-notes Fetch the notes of the remote set in \`git config code-notes.remote\` (or --remote), merge, and push.
sync       Fetch PR review conversations from GitHub into the cache.
classify   Classify cached conversations (haiku uses your Claude login; jev and mercury need OPENROUTER_API_KEY).
report     Summarize the classifications.
import     Write every cached conversation of closed and merged PRs into notes. Deciding relevance is left to whoever
           reads the notes: they delete what no longer matters. Conversations whose note was deleted are skipped.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: "string", default: process.cwd() },
    repo: { type: "string" },
    remote: { type: "string" },
    limit: { type: "string", default: "300" },
    full: { type: "boolean", default: false },
    lines: { type: "string" },
    message: { type: "string", short: "m" },
    reason: { type: "string" },
    "resolve-on-github": { type: "boolean", default: false },
    by: { type: "string" },
    all: { type: "boolean", default: false },
    sample: { type: "string" },
    seed: { type: "string", default: "42" },
    classifier: { type: "string" },
    threshold: { type: "string", default: "0.5" },
    batch: { type: "string", default: "10" },
    concurrency: { type: "string", default: "4" },
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

function show(): void {
  if (!arg) throw new Error("show requires a <file> argument");
  const path = toRepoPath(arg, values.cwd);
  const absolute = join(root(), path);
  const lines = existsSync(absolute) ? readFileSync(absolute, "utf8").split(/\r?\n/) : [];
  const fileNotes = RepoNotes.load(root()).forFile(path);
  const placed = placeNotes(root(), fileNotes.map((n) => n.doc), lines);
  let notes = fileNotes.map((note, i) => ({ note, range: placed[i] }));
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
  // With --resolve-on-github, the reason is posted on the note's open GitHub conversation, which is then resolved.
  if (values["resolve-on-github"] && doc.github && !doc.github.isResolved) {
    const state = await setThreadResolved(doc.github.threadId, true, githubDeletionReply(values.reason));
    s.setGithubResolved(key, state);
    console.log(`Posted the reason on ${doc.github.url} and resolved the conversation.`);
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

function syncNotes(): void {
  const s = store();
  const r = s.sync(values.remote);
  console.log(`${r.fetched ? `Fetched; ${r.merged} notes merged from the remote.` : "The remote has no notes yet."} ${r.pushed ? "Pushed." : "Nothing to push."}`);
}

function importNotes(): void {
  const result = importFromCache(store(), cache().readPrs());
  console.log(`Imported into ${root()}: ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged, ` +
    `${result.skippedDeleted} skipped because deleted.`);
}

/** Deterministic sample: the same seed always yields the same threads, in the same order. */
function sample<T>(items: T[], n: number, seed: number): T[] {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const picked = new Set<number>();
  while (picked.size < Math.min(n, items.length)) picked.add(Math.floor(rnd() * items.length));
  return [...picked].map((i) => items[i]);
}

async function classify(): Promise<void> {
  const all: ThreadInput[] = cache().readPrs().flatMap((pr) => pr.threads.map((thread) => ({ thread, pr })));
  const sampled = values.sample ? sample(all, Number(values.sample), Number(values.seed)) : all;
  // Reviews on open PRs are still in progress and visible on GitHub; they are classified once the PR is closed.
  const inputs = sampled.filter((i) => i.pr.state !== "OPEN");
  if (inputs.length < sampled.length) console.error(`Skipping ${sampled.length - inputs.length} conversations on open PRs.`);
  const classifier = values.classifier ?? "haiku";
  if (classifier !== "haiku" && !SYSTEM_ONE_CLASSIFIERS[classifier]) throw new Error(`Unknown classifier: ${classifier}`);
  const results = cache().readClassifications(classifier);
  const todo: ThreadInput[] = [];
  let prefiltered = 0;
  for (const input of inputs) {
    if (results[input.thread.id]?.hash === threadHash(input)) continue;
    const quick = prefilter(input);
    if (quick) {
      results[input.thread.id] = quick;
      prefiltered++;
    } else todo.push(input);
  }
  cache().writeClassifications(results, classifier);
  console.error(`${inputs.length} conversations selected: ${prefiltered} prefiltered, ${todo.length} to classify with ${classifier}, ${inputs.length - prefiltered - todo.length} already done.`);
  let sinceSave = 0;
  const common = {
    concurrency: Number(values.concurrency),
    log: (msg: string) => console.error(msg),
    onResult: (input: ThreadInput, c: Classification) => {
      results[input.thread.id] = c;
      // Save regularly so an interrupted run keeps its progress.
      if (++sinceSave >= 20) {
        cache().writeClassifications(results, classifier);
        sinceSave = 0;
      }
    },
  };
  if (classifier === "haiku") await classifyWithClaude(todo, { ...common, model: "haiku", batchSize: Number(values.batch) });
  else await classifyWithSystemOne(todo, { ...common, classifier, threshold: Number(values.threshold) });
  cache().writeClassifications(results, classifier);
  const missing = todo.filter((i) => results[i.thread.id]?.hash !== threadHash(i)).length;
  console.error(`Done. ${missing ? `${missing} conversations got no result; rerun to retry them.` : "Every selected conversation is classified."}`);
}

function report(): void {
  const results = cache().readClassifications(values.classifier ?? "haiku");
  const entries = cache().readPrs().flatMap((pr) => pr.threads.filter((t) => results[t.id]).map((t) => ({ t, pr, c: results[t.id] })));
  const n = entries.length;
  const pct = (k: number) => `${k}`.padStart(5) + ` (${((100 * k) / n).toFixed(1).padStart(4)}%)`;
  console.log(`${n} classified conversations\n`);
  console.log("category        total           useful");
  for (const cat of CATEGORIES) {
    const inCat = entries.filter((e) => e.c.category === cat);
    console.log(`${cat.padEnd(13)} ${pct(inCat.length)}  ${inCat.filter((e) => e.c.useful).length}`);
  }
  const useful = entries.filter((e) => e.c.useful);
  console.log(`${"useful".padEnd(13)} ${pct(useful.length)}\n`);
  for (const { t, pr, c } of useful) {
    const tag = [c.category, c.ticket, c.general ? "general" : null].filter(Boolean).join(", ");
    console.log(`- [${tag}] ${c.summary}\n    PR #${pr.number} ${t.path} ${t.comments[0]?.url ?? ""}`);
  }
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
  show, add, comment, delete: del, restore, "sync-notes": syncNotes, import: importNotes,
  sync: () => sync(cache(), { limit: Number(values.limit), full: values.full, log: (msg) => console.error(msg) }).then(() => {}),
  classify, report, stats,
};

try {
  const run = commands[command];
  if (!run) throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  await run();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
