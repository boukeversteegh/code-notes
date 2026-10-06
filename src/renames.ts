import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

interface RenameData {
  commit: string;
  /** Every path in the tree at `commit`. */
  tree: string[];
  /** old path -> new path, for every rename in the history of `commit`. */
  renames: Record<string, string>;
}

/**
 * Maps paths that review threads were written against to where those files live at a given commit.
 * Renames come from `git log -M --diff-filter=R` over the commit's full history.
 */
export class RenameMap {
  private readonly tree: Set<string>;
  private readonly aliasesByPath = new Map<string, string[]>();

  private constructor(readonly commit: string, tree: string[], private readonly renames: Record<string, string>) {
    this.tree = new Set(tree);
  }

  /** Loads the map for `HEAD` of the repo at `root`, computing and caching it on first use per commit. */
  static forHead(root: string, cacheDir: string): RenameMap {
    const commit = git(root, "rev-parse", "HEAD").trim();
    const file = join(cacheDir, "renames.json");
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8")) as RenameData;
      if (data.commit === commit) return new RenameMap(commit, data.tree, data.renames);
    }
    const tree = git(root, "ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean);
    const renames: Record<string, string> = {};
    const lines = git(root, "log", "--format=", "--name-status", "-M", "--diff-filter=R", commit).split("\n");
    // Oldest first, so a path that was renamed more than once ends up at its latest destination.
    for (const line of lines.reverse()) {
      const [status, from, to] = line.split("\t");
      if (status?.startsWith("R") && from && to) renames[from] = to;
    }
    writeFileSync(file, JSON.stringify({ commit, tree, renames } satisfies RenameData));
    return new RenameMap(commit, tree, renames);
  }

  exists(path: string): boolean {
    return this.tree.has(path);
  }

  /** The tree's spelling of `path`; Windows paths may differ in case from what git stores. */
  canonical(path: string): string {
    if (this.tree.has(path)) return path;
    this.byLowerCase ??= new Map([...this.tree].map((p) => [p.toLowerCase(), p]));
    return this.byLowerCase.get(path.toLowerCase()) ?? path;
  }

  private byLowerCase?: Map<string, string>;

  /** Where `path` lives at this commit, following rename chains; null when the file is gone. */
  resolve(path: string): string | null {
    const seen = new Set<string>();
    let current = path;
    while (!this.tree.has(current)) {
      const next = this.renames[current];
      if (!next || seen.has(next)) return null;
      seen.add(current);
      current = next;
    }
    return current;
  }

  /** Earlier paths of `path` (including itself) that threads may be filed under. */
  aliases(path: string, candidates: Iterable<string>): string[] {
    if (this.aliasesByPath.size === 0) {
      for (const old of candidates) {
        const now = this.resolve(old);
        if (now) this.aliasesByPath.set(now, [...(this.aliasesByPath.get(now) ?? []), old]);
      }
    }
    return this.aliasesByPath.get(path) ?? [];
  }
}
