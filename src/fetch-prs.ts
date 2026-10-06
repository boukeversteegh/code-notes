import { Cache } from "./cache.ts";
import { fetchPullRequests } from "./github.ts";

export interface FetchOptions {
  /** Maximum number of PRs to fetch. */
  limit: number;
  /** Keep going past PRs that are unchanged since the last fetch. */
  full: boolean;
  log: (msg: string) => void;
}

export interface FetchResult {
  written: number;
  threads: number;
  files: number;
  cachedPrs: number;
}

/** Fetches PR review conversations from GitHub into the local cache and rebuilds the per-file index. */
export async function fetchPrsIntoCache(cache: Cache, { limit, full, log }: FetchOptions): Promise<FetchResult> {
  const state = cache.readState();
  let written = 0, threads = 0;
  log(`Fetching PR review conversations of ${cache.repo} into ${cache.dir} (limit ${limit}${full ? ", full" : ""})`);
  for await (const pr of fetchPullRequests(cache.repo, log)) {
    if (!full && state.prs[pr.number] === pr.updatedAt) {
      log(`PR #${pr.number} unchanged since the last fetch; stopping.`);
      break;
    }
    cache.writePr(pr);
    state.prs[pr.number] = pr.updatedAt;
    threads += pr.threads.length;
    if (++written >= limit) break;
  }
  state.syncedAt = new Date().toISOString();
  cache.writeState(state);
  const index = cache.buildIndex();
  const result = { written, threads, files: Object.keys(index.files).length, cachedPrs: Object.keys(state.prs).length };
  log(`Wrote ${written} PRs (${threads} threads). Index: ${result.files} files from ${result.cachedPrs} cached PRs.`);
  return result;
}
