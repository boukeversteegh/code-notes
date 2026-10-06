/**
 * Runs everything that calls git, in a worker thread. VS Code runs all extensions on one thread, so blocking
 * git calls there would freeze the editor's extensions (and make buttons seem dead) on a busy machine.
 * The extension sends requests here and stays responsive while git works.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { parentPort } from "node:worker_threads";
import { Cache } from "../../src/cache.ts";
import { fetchPrsIntoCache } from "../../src/fetch-prs.ts";
import { type NoteDoc, NoteStore } from "../../src/gitnotes.ts";
import { setGithubToken } from "../../src/github.ts";
import { importFromCache } from "../../src/importer.ts";
import { RepoNotes, gitDirs } from "../../src/notes.ts";
import { detectRepo, gitRoot } from "../../src/repo.ts";
import { placeNotes } from "../../src/tracking.ts";

export interface RepoInfo {
  root: string;
  gitDir: string;
  commonDir: string;
}

const mtime = (file: string) => {
  try {
    return String(statSync(file).mtimeMs);
  } catch {
    return "-";
  }
};

/** Notes per checkout, reloaded when the notes ref or HEAD changes on disk. */
const loaded = new Map<string, { key: string; notes: RepoNotes }>();
function notesOf(info: RepoInfo): RepoNotes {
  const key = [
    join(info.commonDir, "refs", "notes", "code-notes"),
    join(info.commonDir, "packed-refs"),
    join(info.gitDir, "logs", "HEAD"),
  ].map(mtime).join("|");
  const entry = loaded.get(info.root);
  if (entry?.key === key) return entry.notes;
  const notes = RepoNotes.load(info.root);
  loaded.set(info.root, { key, notes });
  return notes;
}

type Args = Record<string, any>;

const handlers: Record<string, (a: Args, log: (msg: string) => void) => unknown> = {
  repoInfo: ({ dir }) => {
    try {
      const root = gitRoot(dir);
      return { root, ...gitDirs(root) } satisfies RepoInfo;
    } catch {
      return null;
    }
  },
  notesForFile: ({ info, path, lines }) => {
    const notes = notesOf(info).forFile(path);
    return { notes, placed: notes.length ? placeNotes(info.root, notes.map((n) => n.doc), lines) : [] };
  },
  count: ({ info, path }) => notesOf(info).count(path),
  head: ({ root }) => new NoteStore(root).head(),
  author: ({ root }) => new NoteStore(root).author(),
  defaultRemote: ({ root }) => new NoteStore(root).defaultRemote(),
  remote: ({ root }) => new NoteStore(root).remote(),
  /** Writes a new note; its anchor commit is HEAD unless the editor had unsaved changes. */
  createNote: ({ root, key, doc, anchorToHead }) => {
    const store = new NoteStore(root);
    const note: NoteDoc = anchorToHead ? { ...doc, anchor: { ...doc.anchor, commit: store.git(["rev-parse", "HEAD"]).trim() } } : doc;
    store.put(key, `code-notes: add note on ${note.path}`, () => note);
    return null;
  },
  addComment: ({ root, key, comment }) => !!new NoteStore(root).addComment(key, comment),
  editComment: ({ root, key, index, body }) => !!new NoteStore(root).editComment(key, index, body),
  removeComment: ({ root, key, index, createdAt }) => !!new NoteStore(root).removeComment(key, index, createdAt),
  softDelete: ({ root, key, by, reason }) => !!new NoteStore(root).softDelete(key, by, reason),
  sync: ({ root }) => new NoteStore(root).syncAsync(),
  importGithub: async ({ root, token, limit }, log) => {
    setGithubToken(token);
    const store = new NoteStore(root);
    const configured = store.git(["config", "--default", "", "--get", "code-notes.github"]).trim();
    const cache = new Cache(configured || detectRepo(root));
    log(`importing ${cache.repo}`);
    await fetchPrsIntoCache(cache, { limit, full: false, log });
    return importFromCache(store, cache.readPrs());
  },
};

parentPort!.on("message", async ({ id, op, args }: { id: number; op: string; args: Args }) => {
  const log = (msg: string) => parentPort!.postMessage({ id, log: msg });
  try {
    const result = await handlers[op](args, log);
    parentPort!.postMessage({ id, result });
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message ?? String(err) });
  }
});
