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
  /** The GitHub review thread an imported note comes from. Whether it is resolved is looked up on GitHub, not stored. */
  github?: { threadId: string; url: string };
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
  /**
   * Removes one locally written reply. `createdAt` must match, so a reply is never removed by a stale index
   * after the comments changed. The first comment is the note itself: delete the note instead.
   */
  removeComment(key: string, index: number, createdAt: string): NoteDoc | null {
    const now = new Date().toISOString();
    return this.put(key, `code-notes: remove comment from ${key}`, (doc) => {
      const c = doc?.comments[index];
      if (!doc || index === 0 || !c || c.source !== "local" || c.createdAt !== createdAt) return null;
      return { ...doc, comments: doc.comments.filter((_, i) => i !== index), updatedAt: now };
    });
  }

  editComment(key: string, index: number, body: string): NoteDoc | null {
    const now = new Date().toISOString();
    return this.put(key, `code-notes: edit comment on ${key}`, (doc) => {
      const c = doc?.comments[index];
      if (!doc || !c || c.source !== "local" || c.body === body) return null;
      const comments = doc.comments.map((x, i) => (i === index ? { ...x, body, editedAt: now } : x));
      return { ...doc, comments, updatedAt: now };
    });
  }

  /**
   * The remote notes are pulled from and pushed to: `git config code-notes.remote` when set, otherwise the
   * remote the current branch tracks, otherwise `origin`, otherwise the only remote. Null when the repo has
   * no remote (notes then stay local) or several remotes and none of them is the default.
   */
  defaultRemote(): string | null {
    const get = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: this.root, encoding: "utf8" });
      return r.status === 0 ? r.stdout.trim() : "";
    };
    const override = get("config", "--get", "code-notes.remote");
    if (override) return override;
    const branch = get("symbolic-ref", "--short", "-q", "HEAD");
    const tracked = branch ? get("config", "--get", `branch.${branch}.remote`) : "";
    if (tracked && tracked !== ".") return tracked;
    const remotes = get("remote").split(/\r?\n/).filter(Boolean);
    if (remotes.includes("origin")) return "origin";
    return remotes.length === 1 ? remotes[0] : null;
  }

  /** defaultRemote(), or an error explaining how to choose one. */
  remote(): string {
    const remote = this.defaultRemote();
    if (!remote) throw new Error("This repository has no default remote for code notes. Choose one with: git config code-notes.remote <remote-name>");
    return remote;
  }

  /** Merges the notes of `theirs` into the local ref. Only notes whose blobs differ are read. */
  private mergeFrom(theirs: string, remote: string): number {
    const ours = this.head();
    if (ours === theirs) return 0;
    if (!ours || this.isAncestor(ours, theirs)) {
      // The remote's notes include ours: take them over, and count the notes that changed.
      const changed = ours
        ? this.git(["diff-tree", "-r", "--name-only", "--no-renames", ours, theirs]).split("\n").filter(Boolean).length
        : this.listEntries(theirs).length;
      this.git(["update-ref", "-m", "code-notes: fast-forward", this.ref, theirs, ours ?? ZERO]);
      return changed;
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

  /** Commit of the notes ref on the remote, from `git ls-remote` output; null when the remote has no notes. */
  private static remoteHead(lsRemote: string): string | null {
    return lsRemote.trim().split(/\s+/)[0] || null;
  }

  /**
   * Fetch arguments for the notes ref. Negotiation uses only the previously fetched notes commit; by default
   * git offers every local ref, which is slow in clones with many refs (such as fetched PR branches).
   */
  private fetchArgs(remote: string, tracking: string): string[] {
    const tip = this.head(tracking);
    return ["fetch", "-q", ...(tip ? [`--negotiation-tip=${tracking}`] : []), remote, `+${this.ref}:${tracking}`];
  }

  /** Fetches the remote's notes and merges them per note into the local notes. Skips the fetch when nothing is new. */
  pull(remote = this.remote()): { fetched: boolean; merged: number; remoteHead: string | null } {
    const tracking = `refs/code-notes-remotes/${remote}`;
    const theirs = NoteStore.remoteHead(this.git(["ls-remote", remote, this.ref]));
    if (!theirs) return { fetched: false, merged: 0, remoteHead: null };
    if (this.head(tracking) !== theirs) this.git(this.fetchArgs(remote, tracking));
    return { fetched: true, merged: this.mergeFrom(theirs, remote), remoteHead: theirs };
  }

  /**
   * Pushes the local notes. A push is never forced: when the remote has notes that are not here yet,
   * it is rejected and a pull (or sync) has to merge them first.
   */
  push(remote = this.remote(), remoteHead?: string | null): "pushed" | "rejected" | "up-to-date" | "no-notes" {
    const head = this.head();
    if (!head) return "no-notes";
    if (remoteHead === undefined) remoteHead = NoteStore.remoteHead(this.git(["ls-remote", remote, this.ref]));
    if (head === remoteHead) return "up-to-date"; // the remote already has these notes
    const r = spawnSync("git", ["push", "-q", remote, `${this.ref}:${this.ref}`], { cwd: this.root, encoding: "utf8" });
    if (r.status === 0) return "pushed";
    if (/rejected|non-fast-forward|fetch first/i.test(r.stderr)) return "rejected";
    throw new Error(`Could not push ${this.ref} to ${remote}: ${r.stderr.trim()}`);
  }

  /** Pull, then push; repeats when someone pushed in between. */
  sync(remote = this.remote()): { fetched: boolean; merged: number; pushed: boolean } {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { fetched, merged, remoteHead } = this.pull(remote);
      const pushed = this.push(remote, remoteHead);
      if (pushed !== "rejected") return { fetched, merged, pushed: pushed === "pushed" };
    }
    throw new Error(`Could not push ${this.ref} to ${remote}.`);
  }

  /** Like sync(), but the network steps (ls-remote, fetch, push) do not block the calling thread. */
  async syncAsync(remote = this.remote()): Promise<{ fetched: boolean; merged: number; pushed: boolean }> {
    const tracking = `refs/code-notes-remotes/${remote}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const theirs = NoteStore.remoteHead((await this.gitAsync(["ls-remote", remote, this.ref])).stdout);
      const exists = theirs !== null;
      // Only fetch when the remote has a notes commit that is not here yet.
      if (theirs && this.head(tracking) !== theirs && !(await this.gitAsync(this.fetchArgs(remote, tracking))).ok) {
        throw new Error(`Could not fetch notes from ${remote}.`);
      }
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
