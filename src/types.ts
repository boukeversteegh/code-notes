export interface ReviewComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

/** One review conversation anchored to a file (and usually a line range) in a PR. */
export interface ReviewThread {
  id: string;
  path: string;
  /** Line range on the PR head commit; null when the thread is outdated or file-level. */
  startLine: number | null;
  line: number | null;
  /** Line range on the commit the first comment was written against. */
  originalStartLine: number | null;
  originalLine: number | null;
  originalCommit: string | null;
  diffSide: "LEFT" | "RIGHT";
  subjectType: "LINE" | "FILE";
  isResolved: boolean;
  isOutdated: boolean;
  diffHunk: string;
  comments: ReviewComment[];
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  author: string;
  updatedAt: string;
  mergedAt: string | null;
  headCommit: string;
  threads: ReviewThread[];
}

export interface FileThread extends ReviewThread {
  pr: Pick<PullRequest, "number" | "title" | "url" | "state" | "mergedAt">;
}

export interface FileIndex {
  repo: string;
  builtAt: string;
  files: Record<string, FileThread[]>;
}

export interface SyncState {
  repo: string;
  syncedAt: string;
  /** updatedAt of every cached PR, used to skip unchanged PRs on incremental syncs. */
  prs: Record<string, string>;
}
