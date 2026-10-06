import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { NoteAnchor } from "./anchor.ts";

export type { NoteAnchor };

/**
 * Code notes stored in git notes.
 *
 * All notes live on one notes ref. Each note is a JSON document stored as a git note on a "key object":
 * the blob hash of a stable id string (`github-review-thread:<id>`, `manual:<uuid>`), so every clone
 * computes the same key for the same GitHub conversation. Deleting a note keeps the document as a
 * tombstone, so a later GitHub import skips it and a sync spreads the deletion to other clones.
 */

export const NOTES_REF = "refs/notes/code-notes";
const ZERO = "0".repeat(40);
const execFileAsync = promisify(execFile);

export interface NoteComment {
  author: string;
  body: string;
  createdAt: string;
  /** GitHub comment URL; absent for comments added locally. */
  url?: string;
  source: "github" | "local";
  editedAt?: string;
}

export interface NoteDoc {
  schema: 1;
  id: string;
  source: "github-review" | "manual";
  /** Path at the anchor commit. */
  path: string;
  anchor: NoteAnchor;
  summary: string | null;
  comments: NoteComment[];
  pr: { number: number; title: string; url: string; state: string } | null;
  /** The GitHub review thread an imported note comes from, with its last known resolution state. */
  github?: { threadId: string; url: string; isResolved: boolean; checkedAt: string };
  createdAt: string;
  /** Last change to the content (everything except the deletion state). */
  updatedAt: string;
  deleted: { at: string; by: string; reason: string } | null;
  /** Last time a deleted note was restored. */
  restoredAt: string | null;
}

/** Git's object id for a blob with this content. */
function blobId(body: Buffer): string {
  return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

/** Key object a note is attached to: the blob id of its stable id string. */
export function keyFor(id: string): string {
  return blobId(Buffer.from(id, "utf8"));
}

export const newManualId = () => `manual:${randomUUID()}`;

function deletionEventAt(d: NoteDoc): string {
  return d.deleted?.at ?? d.restoredAt ?? "";
}

/**
 * Merges two versions of the same note. Content follows the later `updatedAt`; the deletion state
 * follows the later delete/restore event, so an edit made without knowing about a deletion cannot undo it.
 */
export function mergeDocs(a: NoteDoc, b: NoteDoc): NoteDoc {
  const content = a.updatedAt >= b.updatedAt ? a : b;
  const ea = deletionEventAt(a), eb = deletionEventAt(b);
  // On a tie the deleted version wins.
  const state = ea > eb ? a : eb > ea ? b : a.deleted ? a : b;
  return { ...content, deleted: state.deleted, restoredAt: state.restoredAt };
}

const stableJson = (doc: NoteDoc) => `${JSON.stringify(doc, null, 2)}\n`;

/**
 * The notes of one notes commit, read lazily: the tree listing is cheap, so only the notes that are asked
 * for (or `loadAll()`) are parsed. Unchanged notes keep their blob when the set is committed.
 */
export class NoteSet {
  private readonly entries = new Map<string, { blob?: string; doc?: NoteDoc }>();

  constructor(private readonly store: NoteStore, listing: { key: string; blob: string }[]) {
    for (const e of listing) this.entries.set(e.key, { blob: e.blob });
  }

  /** Parses the given notes (all when omitted) in one cat-file call. */
  load(keys: Iterable<string> = this.entries.keys()): void {
    const missing = [...keys].map((k) => this.entries.get(k)).filter((e) => e && !e.doc && e.blob) as { blob: string; doc?: NoteDoc }[];
    if (missing.length === 0) return;
    const docs = this.store.readBlobs(missing.map((e) => e.blob));
    for (const e of missing) e.doc = docs.get(e.blob);
  }

  blob(key: string): string | undefined {
    return this.entries.get(key)?.blob;
  }

  get(key: string): NoteDoc | undefined {
    this.load([key]);
    return this.entries.get(key)?.doc;
  }

  set(key: string, doc: NoteDoc): void {
    this.entries.set(key, { doc });
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  /** Tree lines for `git mktree`, writing new blobs first. */
  treeLines(write: (docs: { doc: NoteDoc; setBlob: (b: string) => void }[]) => void): string {
    const pending = [...this.entries.values()].filter((e) => !e.blob && e.doc);
    write(pending.map((e) => ({ doc: e.doc!, setBlob: (b) => (e.blob = b) })));
    return [...this.entries].filter(([, e]) => e.blob).map(([key, e]) => `100644 blob ${e.blob}\t${key}\n`).join("");
  }
}

export class NoteStore {
  constructor(readonly root: string, readonly ref = NOTES_REF) {}

  git(args: string[], input?: string): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8", input, maxBuffer: 512 * 1024 * 1024 });
  }

  private async gitAsync(args: string[]): Promise<{ ok: boolean; stdout: string }> {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: this.root, maxBuffer: 64 * 1024 * 1024 });
      return { ok: true, stdout };
    } catch {
      return { ok: false, stdout: "" };
    }
  }

  /** Commit the ref points at, or null when it does not exist yet. */
  head(ref = this.ref): string | null {
    const r = spawnSync("git", ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: this.root, encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  }

  /** Key object and note blob of every note on `refOrCommit`, without reading the notes. */
  listEntries(refOrCommit: string | null = this.head()): { key: string; blob: string }[] {
    if (!refOrCommit) return [];
    return this.git(["ls-tree", "-r", "-z", refOrCommit])
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        return { blob: meta.split(" ")[2], key: path.replaceAll("/", "") }; // notes trees may use a fanout like ab/cdef…
      });
  }

  /** Parses note blobs in one cat-file process. Blobs that are not code-notes JSON are left out. */
  readBlobs(blobs: string[]): Map<string, NoteDoc> {
    const result = new Map<string, NoteDoc>();
    if (blobs.length === 0) return result;
    const out = execFileSync("git", ["cat-file", "--batch"], {
      cwd: this.root, input: blobs.join("\n") + "\n", maxBuffer: 1024 * 1024 * 1024,
    });
    let pos = 0;
    for (const blob of blobs) {
      const headerEnd = out.indexOf(0x0a, pos);
      const size = Number(out.toString("utf8", pos, headerEnd).split(" ")[2]);
      const body = out.toString("utf8", headerEnd + 1, headerEnd + 1 + size);
      pos = headerEnd + 1 + size + 1;
      try {
        result.set(blob, JSON.parse(body) as NoteDoc);
      } catch {
        // Not one of ours (e.g. a plain-text note added by hand); ignore it.
      }
    }
    return result;
  }

  /** Every note on `ref` (or on a given commit), keyed by key object. */
  readAll(refOrCommit: string | null = this.head()): Map<string, { blob: string; doc: NoteDoc }> {
    const entries = this.listEntries(refOrCommit);
    const docs = this.readBlobs(entries.map((e) => e.blob));
    const result = new Map<string, { blob: string; doc: NoteDoc }>();
    for (const e of entries) {
      const doc = docs.get(e.blob);
      if (doc) result.set(e.key, { blob: e.blob, doc });
    }
    return result;
  }

  /** Writes `set` as a new notes commit. Only new or changed notes get new blobs. */
  private commit(set: NoteSet, parents: string[], message: string): string {
    const lines = set.treeLines((pending) => {
      if (pending.length === 0) return;
      // One fast-import process writes all new blobs into a single pack; their ids are computed here.
      const chunks: Buffer[] = [];
      for (const p of pending) {
        const body = Buffer.from(stableJson(p.doc), "utf8");
        p.setBlob(blobId(body));
        chunks.push(Buffer.from(`blob\ndata ${body.length}\n`), body, Buffer.from("\n"));
      }
      execFileSync("git", ["fast-import", "--quiet"], { cwd: this.root, input: Buffer.concat(chunks), maxBuffer: 64 * 1024 * 1024 });
    });
    const tree = this.git(["mktree"], lines).trim();
    return this.git(["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message]).trim();
  }

  /**
   * Read-modify-write on the notes ref. `mutate` changes the set in place and returns false when nothing
   * changed. Notes are read lazily, so changing one note does not read the others. The ref update is
   * compare-and-swap, so concurrent writers retry instead of losing data.
   */
  update(message: string, mutate: (docs: NoteSet) => boolean, extraParent?: string): boolean {
    for (let attempt = 0; attempt < 5; attempt++) {
      const old = this.head();
      const set = new NoteSet(this, this.listEntries(old));
      if (!mutate(set)) return false;
      const parents = [...(old ? [old] : []), ...(extraParent ? [extraParent] : [])];
      const commit = this.commit(set, parents, message);
      const r = spawnSync("git", ["update-ref", "-m", message, this.ref, commit, old ?? ZERO], { cwd: this.root, encoding: "utf8" });
      if (r.status === 0) return true;
    }
    throw new Error(`Could not update ${this.ref}: it kept changing concurrently.`);
  }

  get(key: string): NoteDoc | null {
    return new NoteSet(this, this.listEntries()).get(key) ?? null;
  }

  /** Writes one note; `change` receives the current version (or null) and returns the new one. */
  put(key: string, message: string, change: (current: NoteDoc | null) => NoteDoc | null): NoteDoc | null {
    let written: NoteDoc | null = null;
    this.update(message, (docs) => {
      const next = change(docs.get(key) ?? null);
      if (!next) return false;
      docs.set(key, next);
      written = next;
      return true;
    });
    return written;
  }

  softDelete(key: string, by: string, reason: string): NoteDoc | null {
    return this.put(key, `code-notes: delete ${key}`, (doc) =>
      doc && !doc.deleted ? { ...doc, deleted: { at: new Date().toISOString(), by, reason } } : null);
  }

  restore(key: string): NoteDoc | null {
    return this.put(key, `code-notes: restore ${key}`, (doc) =>
      doc?.deleted ? { ...doc, deleted: null, restoredAt: new Date().toISOString() } : null);
  }

  addComment(key: string, comment: Omit<NoteComment, "source">): NoteDoc | null {
    const now = new Date().toISOString();
    return this.put(key, `code-notes: comment on ${key}`, (doc) =>
      doc ? { ...doc, comments: [...doc.comments, { ...comment, source: "local" }], updatedAt: now } : null);
  }

  /** Replaces the body of a locally written comment. GitHub comments are owned by GitHub and not editable here. */
  editComment(key: string, index: number, body: string): NoteDoc | null {
    const now = new Date().toISOString();
    return this.put(key, `code-notes: edit comment on ${key}`, (doc) => {
      const c = doc?.comments[index];
      if (!doc || !c || c.source !== "local" || c.body === body) return null;
      const comments = doc.comments.map((x, i) => (i === index ? { ...x, body, editedAt: now } : x));
      return { ...doc, comments, updatedAt: now };
    });
  }

  /** Records the GitHub resolution state of an imported note's thread. */
  setGithubResolved(key: string, isResolved: boolean): NoteDoc | null {
    const now = new Date().toISOString();
    return this.put(key, `code-notes: thread ${isResolved ? "resolved" : "reopened"} on GitHub`, (doc) =>
      doc?.github && doc.github.isResolved !== isResolved
        ? { ...doc, github: { ...doc.github, isResolved, checkedAt: now }, updatedAt: now }
        : null);
  }

  /** Remote configured for note sync. Deliberately not defaulted to origin, so notes are never pushed by accident. */
  configuredRemote(): string {
    const r = spawnSync("git", ["config", "--get", "code-notes.remote"], { cwd: this.root, encoding: "utf8" });
    const remote = r.stdout.trim();
    if (r.status !== 0 || !remote) {
      throw new Error("No remote configured for code notes. Set one with: git config code-notes.remote <remote-name>");
    }
    return remote;
  }

  /** Merges the notes of `theirs` into the local ref. Only notes whose blobs differ are read. */
  private mergeFrom(theirs: string, remote: string): number {
    const ours = this.head();
    if (!ours || this.isAncestor(ours, theirs)) {
      this.git(["update-ref", "-m", "code-notes: fast-forward", this.ref, theirs, ours ?? ZERO]);
      return 0;
    }
    if (this.isAncestor(theirs, ours)) return 0;
    let merged = 0;
    const remoteSet = new NoteSet(this, this.listEntries(theirs));
    this.update(`code-notes: merge ${remote}`, (local) => {
      merged = 0;
      const differing = [...remoteSet.keys()].filter((k) => remoteSet.blob(k) !== local.blob(k));
      remoteSet.load(differing);
      local.load(differing);
      for (const key of differing) {
        const r = remoteSet.get(key);
        if (!r) continue;
        const l = local.get(key);
        const next = l ? mergeDocs(l, r) : r;
        if (!l || stableJson(next) !== stableJson(l)) {
          local.set(key, next);
          merged++;
        }
      }
      return true; // always record the merge, so both histories are ancestors of the result
    }, theirs);
    return merged;
  }

  /**
   * Fetches the remote's notes, merges them per note into the local notes, and pushes the result.
   * Returns what happened, for logging.
   */
  sync(remote = this.configuredRemote()): { fetched: boolean; merged: number; pushed: boolean } {
    const tracking = `refs/code-notes-remotes/${remote}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const exists = this.git(["ls-remote", remote, this.ref]).trim() !== "";
      if (exists) this.git(["fetch", "-q", remote, `+${this.ref}:${tracking}`]);
      const theirs = exists ? this.head(tracking) : null;
      const merged = theirs ? this.mergeFrom(theirs, remote) : 0;
      if (!this.head()) return { fetched: exists, merged, pushed: false };
      const push = spawnSync("git", ["push", "-q", remote, `${this.ref}:${this.ref}`], { cwd: this.root, encoding: "utf8" });
      if (push.status === 0) return { fetched: exists, merged, pushed: true };
      // Someone pushed in between; fetch and merge again.
    }
    throw new Error(`Could not push ${this.ref} to ${remote}.`);
  }

  /** Like sync(), but the network steps (ls-remote, fetch, push) do not block the calling thread. */
  async syncAsync(remote = this.configuredRemote()): Promise<{ fetched: boolean; merged: number; pushed: boolean }> {
    const tracking = `refs/code-notes-remotes/${remote}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const exists = (await this.gitAsync(["ls-remote", remote, this.ref])).stdout.trim() !== "";
      if (exists && !(await this.gitAsync(["fetch", "-q", remote, `+${this.ref}:${tracking}`])).ok) throw new Error(`Could not fetch notes from ${remote}.`);
      const theirs = exists ? this.head(tracking) : null;
      const merged = theirs ? this.mergeFrom(theirs, remote) : 0;
      if (!this.head()) return { fetched: exists, merged, pushed: false };
      // Skip the push when the remote already has our notes.
      if (theirs && theirs === this.head()) return { fetched: exists, merged, pushed: false };
      if ((await this.gitAsync(["push", "-q", remote, `${this.ref}:${this.ref}`])).ok) return { fetched: exists, merged, pushed: true };
    }
    throw new Error(`Could not push ${this.ref} to ${remote}.`);
  }

  private isAncestor(a: string, b: string): boolean {
    return spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: this.root }).status === 0;
  }

  private static authors = new Map<string, string>();

  /** `user.name <user.email>` of this checkout, for authorship of new notes (cached per checkout). */
  author(): string {
    const cached = NoteStore.authors.get(this.root);
    if (cached) return cached;
    const get = (k: string) => spawnSync("git", ["config", "--get", k], { cwd: this.root, encoding: "utf8" }).stdout.trim();
    const name = get("user.name"), email = get("user.email");
    const author = name ? (email ? `${name} <${email}>` : name) : email || "unknown";
    NoteStore.authors.set(this.root, author);
    return author;
  }
}
