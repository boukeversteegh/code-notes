import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchThreadStates } from "./github.ts";
import { gitDirs } from "./notes.ts";

/**
 * Whether GitHub review conversations are resolved. This is not part of the notes: it is looked up on
 * GitHub when notes are shown, and cached for a few minutes in the shared git dir, so the CLI, the
 * extension and all worktrees of a repo share one cache.
 */
export class ThreadStates {
  private readonly file: string;
  private states: Record<string, { isResolved: boolean; checkedAt: number }>;

  constructor(root: string, private readonly maxAgeMs = 5 * 60_000) {
    const dir = join(gitDirs(root).commonDir, "code-notes");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "github-thread-states.json");
    try {
      this.states = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
    } catch {
      this.states = {};
    }
  }

  /** The cached state, or undefined when unknown or older than the maximum age. */
  get(threadId: string): boolean | undefined {
    const s = this.states[threadId];
    return s && Date.now() - s.checkedAt <= this.maxAgeMs ? s.isResolved : undefined;
  }

  set(threadId: string, isResolved: boolean): void {
    this.states[threadId] = { isResolved, checkedAt: Date.now() };
    this.save();
  }

  /** Looks up the threads whose cached state is missing or stale; needs a GitHub token. */
  async refresh(threadIds: string[]): Promise<Map<string, boolean>> {
    const stale = [...new Set(threadIds)].filter((id) => this.get(id) === undefined);
    if (stale.length > 0) {
      const fetched = await fetchThreadStates(stale);
      const now = Date.now();
      for (const [id, isResolved] of fetched) this.states[id] = { isResolved, checkedAt: now };
      this.save();
    }
    return new Map(threadIds.flatMap((id) => {
      const s = this.get(id);
      return s === undefined ? [] : [[id, s] as [string, boolean]];
    }));
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.states));
  }
}
