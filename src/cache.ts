import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Classification } from "./classify.ts";
import type { FileIndex, FileThread, PullRequest, SyncState } from "./types.ts";

/**
 * Cache layout (outside the target repo, so nothing is written into it):
 *   <root>/<owner>__<name>/state.json      sync bookkeeping
 *   <root>/<owner>__<name>/prs/<n>.json    one normalized PR with its review threads
 *   <root>/<owner>__<name>/index.json      threads aggregated by file path
 */
export class Cache {
  readonly dir: string;

  constructor(readonly repo: string) {
    const root = process.env.CODE_NOTES_CACHE ?? join(homedir(), ".cache", "code-notes");
    this.dir = join(root, repo.replace("/", "__"));
    mkdirSync(join(this.dir, "prs"), { recursive: true });
  }

  private read<T>(file: string): T | null {
    const path = join(this.dir, file);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  }

  private write(file: string, data: unknown): void {
    writeFileSync(join(this.dir, file), JSON.stringify(data, null, 2));
  }

  readState(): SyncState {
    return this.read<SyncState>("state.json") ?? { repo: this.repo, syncedAt: "", prs: {} };
  }

  writeState(state: SyncState): void {
    this.write("state.json", state);
  }

  writePr(pr: PullRequest): void {
    this.write(join("prs", `${pr.number}.json`), pr);
  }

  /** Every cached PR, in file-name order (stable, so seeded samples are reproducible). */
  readPrs(): PullRequest[] {
    return readdirSync(join(this.dir, "prs")).sort().map((entry) => this.read<PullRequest>(join("prs", entry))!);
  }

  /** Classifications keyed by thread id; each classifier has its own file. Haiku's is the default. */
  readClassifications(classifier = "haiku"): Record<string, Classification> {
    return this.read<Record<string, Classification>>(classificationsFile(classifier)) ?? {};
  }

  writeClassifications(data: Record<string, Classification>, classifier = "haiku"): void {
    this.write(classificationsFile(classifier), data);
  }

  readIndex(): FileIndex | null {
    return this.read<FileIndex>("index.json");
  }

  /** Rebuilds index.json from every cached PR. */
  buildIndex(): FileIndex {
    const files: Record<string, FileThread[]> = {};
    for (const entry of readdirSync(join(this.dir, "prs"))) {
      const pr = this.read<PullRequest>(join("prs", entry))!;
      const prRef = { number: pr.number, title: pr.title, url: pr.url, state: pr.state, mergedAt: pr.mergedAt };
      for (const thread of pr.threads) {
        (files[thread.path] ??= []).push({ ...thread, pr: prRef });
      }
    }
    for (const threads of Object.values(files)) {
      threads.sort((a, b) => (b.comments[0]?.createdAt ?? "").localeCompare(a.comments[0]?.createdAt ?? ""));
    }
    const index: FileIndex = { repo: this.repo, builtAt: new Date().toISOString(), files };
    this.write("index.json", index);
    return index;
  }
}

const classificationsFile = (classifier: string) =>
  classifier === "haiku" ? "classifications.json" : `classifications-${classifier}.json`;

/**
 * Threads for a repo-relative path. Windows paths are case-insensitive while GitHub paths are not,
 * so an exact match is preferred and a case-insensitive one is the fallback.
 */
export function findFileThreads(index: FileIndex, path: string): { key: string; threads: FileThread[] } {
  const key = path in index.files ? path : Object.keys(index.files).find((k) => k.toLowerCase() === path.toLowerCase());
  return key ? { key, threads: index.files[key] } : { key: path, threads: [] };
}
