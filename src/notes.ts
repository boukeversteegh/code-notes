import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type NoteDoc, NoteStore } from "./gitnotes.ts";
import { RenameMap } from "./renames.ts";

export interface FileNote {
  key: string;
  doc: NoteDoc;
  /** Set when the note was written against an earlier name of the file. */
  originalPath: string | null;
}

/** The worktree's own git dir and the git dir shared by all worktrees of the repo. */
export function gitDirs(root: string): { gitDir: string; commonDir: string } {
  const [gitDir, commonDir] = spawnSync("git", ["rev-parse", "--git-dir", "--git-common-dir"], { cwd: root, encoding: "utf8" })
    .stdout.trim().split(/\r?\n/).map((d) => resolve(root, d));
  return { gitDir, commonDir };
}

/**
 * Directory for derived data that depends on HEAD (the rename map). It lives in the worktree's own git dir,
 * because worktrees share the notes ref but each has its own HEAD.
 */
export function worktreeDataDir(root: string): string {
  const dir = join(gitDirs(root).gitDir, "code-notes");
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface IndexEntry {
  key: string;
  blob: string;
  originalPath: string | null;
  createdAt: string;
}

interface PathIndex {
  notesHead: string | null;
  head: string;
  byPath: Record<string, IndexEntry[]>;
}

/**
 * The live (not deleted) notes of a checkout, looked up by the file's current path.
 *
 * The path -> notes index is cached per worktree and rebuilt only when the notes ref or HEAD changes,
 * so a lookup reads only the notes of the requested file.
 */
export class RepoNotes {
  private byLowerCase?: Map<string, string>;

  private constructor(readonly store: NoteStore, private readonly index: PathIndex) {}

  static load(root: string): RepoNotes {
    const store = new NoteStore(root);
    const notesHead = store.head();
    const head = store.git(["rev-parse", "HEAD"]).trim();
    const file = join(worktreeDataDir(root), "notes-index.json");
    let cached: PathIndex | null = null;
    if (existsSync(file)) {
      try {
        cached = JSON.parse(readFileSync(file, "utf8")) as PathIndex;
        if (cached.notesHead === notesHead && cached.head === head) return new RepoNotes(store, cached);
      } catch {
        cached = null; // corrupt or partial cache; rebuild it
      }
    }
    const renames = RenameMap.forHead(root, worktreeDataDir(root));
    const add = (byPath: Record<string, IndexEntry[]>, key: string, blob: string, doc: NoteDoc) => {
      if (doc.deleted) return;
      // Files that are not committed yet are not in HEAD's tree but can have notes too.
      const current = renames.resolve(doc.path) ?? (existsSync(join(root, doc.path)) ? doc.path : null);
      if (!current) return; // the file no longer exists
      (byPath[current] ??= []).push({ key, blob, originalPath: current === doc.path ? null : doc.path, createdAt: doc.createdAt });
    };
    let byPath: Record<string, IndexEntry[]>;
    if (cached && cached.head === head && cached.notesHead && notesHead) {
      // Same HEAD, notes changed (a write here, in another worktree, or a sync): re-read only the changed notes.
      const changed = store.git(["diff-tree", "-r", "--no-renames", "-z", cached.notesHead, notesHead]).split("\0").filter(Boolean);
      const keys = new Map<string, string | null>(); // key -> new blob, null when removed
      for (let i = 0; i + 1 < changed.length; i += 2) {
        const [, , , newBlob, status] = changed[i].slice(1).split(" ");
        keys.set(changed[i + 1].replaceAll("/", ""), status === "D" ? null : newBlob);
      }
      byPath = {};
      for (const [path, list] of Object.entries(cached.byPath)) {
        const kept = list.filter((e) => !keys.has(e.key));
        if (kept.length) byPath[path] = kept;
      }
      const blobs = [...keys.values()].filter((b): b is string => !!b);
      const docs = store.readBlobs(blobs);
      for (const [key, blob] of keys) if (blob && docs.get(blob)) add(byPath, key, blob, docs.get(blob)!);
    } else {
      byPath = {};
      for (const [key, { blob, doc }] of store.readAll(notesHead)) add(byPath, key, blob, doc);
    }
    for (const list of Object.values(byPath)) list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const index = { notesHead, head, byPath };
    writeFileSync(file, JSON.stringify(index));
    return new RepoNotes(store, index);
  }

  /** Index entries for a path; paths on Windows may differ in case from what git stores. */
  private entries(repoPath: string): IndexEntry[] {
    const exact = this.index.byPath[repoPath];
    if (exact) return exact;
    this.byLowerCase ??= new Map(Object.keys(this.index.byPath).map((p) => [p.toLowerCase(), p]));
    const actual = this.byLowerCase.get(repoPath.toLowerCase());
    return actual ? this.index.byPath[actual] : [];
  }

  /** Number of live notes on a file, without reading them. */
  count(repoPath: string): number {
    return this.entries(repoPath).length;
  }

  forFile(repoPath: string): FileNote[] {
    const entries = this.entries(repoPath);
    const docs = this.store.readBlobs(entries.map((e) => e.blob));
    return entries.flatMap((e) => {
      const doc = docs.get(e.blob);
      return doc ? [{ key: e.key, doc, originalPath: e.originalPath }] : [];
    });
  }
}

export { locate } from "./anchor.ts";
