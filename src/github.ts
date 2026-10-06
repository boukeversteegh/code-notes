import { execFileSync } from "node:child_process";
import type { PullRequest, ReviewComment, ReviewThread } from "./types.ts";

const ENDPOINT = "https://api.github.com/graphql";
const PRS_PER_PAGE = 25;
const THREADS_PER_PAGE = 50;
const COMMENTS_PER_PAGE = 30;

function resolveToken(): string {
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (env) return env;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("No GitHub token: set GITHUB_TOKEN or log in with `gh auth login`.");
  }
}

let token: string | undefined;

/** Overrides the token source, e.g. with a VS Code GitHub authentication session. */
export function setGithubToken(value: string): void {
  token = value;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `bearer ${(token ??= resolveToken())}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: T; errors?: unknown[] };
  if (json.errors?.length) throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data!;
}

const COMMENT_FIELDS = `author { login } body createdAt url pullRequestReview { state }`;

const THREAD_FIELDS = `
  id path line startLine originalLine originalStartLine diffSide subjectType isResolved isOutdated
  comments(first: ${COMMENTS_PER_PAGE}) {
    pageInfo { hasNextPage endCursor }
    nodes { ${COMMENT_FIELDS} diffHunk originalCommit { oid } }
  }`;

const PRS_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PRS_PER_PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url state updatedAt mergedAt headRefOid author { login }
        reviewThreads(first: ${THREADS_PER_PAGE}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${THREAD_FIELDS} }
        }
      }
    }
  }
  rateLimit { remaining resetAt }
}`;

const BRANCH_PRS_QUERY = `
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url state updatedAt mergedAt headRefOid author { login }
        reviewThreads(first: ${THREADS_PER_PAGE}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${THREAD_FIELDS} }
        }
      }
    }
  }
}`;

const MORE_THREADS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREADS_PER_PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${THREAD_FIELDS} }
      }
    }
  }
}`;

const MORE_COMMENTS_QUERY = `
query($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${COMMENT_FIELDS} }
      }
    }
  }
}`;

interface PageInfo { hasNextPage: boolean; endCursor: string | null }
interface RawComment { author: { login: string } | null; body: string; createdAt: string; url: string; pullRequestReview: { state: string } | null; diffHunk?: string; originalCommit?: { oid: string } | null }
interface RawThread {
  id: string; path: string; line: number | null; startLine: number | null;
  originalLine: number | null; originalStartLine: number | null;
  diffSide: "LEFT" | "RIGHT"; subjectType: "LINE" | "FILE"; isResolved: boolean; isOutdated: boolean;
  comments: { pageInfo: PageInfo; nodes: RawComment[] };
}
interface RawPr {
  number: number; title: string; url: string; state: PullRequest["state"]; updatedAt: string;
  mergedAt: string | null; headRefOid: string; author: { login: string } | null;
  reviewThreads: { pageInfo: PageInfo; nodes: RawThread[] };
}

const toComment = (c: RawComment): ReviewComment => ({
  author: c.author?.login ?? "ghost",
  body: c.body,
  createdAt: c.createdAt,
  url: c.url,
});

// Unsubmitted draft comments are only visible to the token owner and may never be posted.
const isPublished = (c: RawComment) => c.pullRequestReview?.state !== "PENDING";

async function toThread(t: RawThread): Promise<ReviewThread> {
  const comments = t.comments.nodes.filter(isPublished).map(toComment);
  let page = t.comments.pageInfo;
  while (page.hasNextPage) {
    const data = await graphql<{ node: { comments: { pageInfo: PageInfo; nodes: RawComment[] } } }>(
      MORE_COMMENTS_QUERY, { id: t.id, after: page.endCursor });
    comments.push(...data.node.comments.nodes.filter(isPublished).map(toComment));
    page = data.node.comments.pageInfo;
  }
  const first = t.comments.nodes[0];
  return {
    id: t.id,
    path: t.path,
    startLine: t.startLine,
    line: t.line,
    originalStartLine: t.originalStartLine,
    originalLine: t.originalLine,
    originalCommit: first?.originalCommit?.oid ?? null,
    diffSide: t.diffSide,
    subjectType: t.subjectType,
    isResolved: t.isResolved,
    isOutdated: t.isOutdated,
    diffHunk: first?.diffHunk ?? "",
    comments,
  };
}

async function toPullRequest(owner: string, name: string, pr: RawPr): Promise<PullRequest> {
  const rawThreads = [...pr.reviewThreads.nodes];
  let page = pr.reviewThreads.pageInfo;
  while (page.hasNextPage) {
    const data = await graphql<{ repository: { pullRequest: { reviewThreads: RawPr["reviewThreads"] } } }>(
      MORE_THREADS_QUERY, { owner, name, number: pr.number, after: page.endCursor });
    rawThreads.push(...data.repository.pullRequest.reviewThreads.nodes);
    page = data.repository.pullRequest.reviewThreads.pageInfo;
  }
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    author: pr.author?.login ?? "ghost",
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    headCommit: pr.headRefOid,
    threads: (await Promise.all(rawThreads.map(toThread))).filter((t) => t.comments.length > 0),
  };
}

/**
 * Yields PRs ordered by most recently updated. The caller decides when to stop
 * (limit reached, or an unchanged PR is encountered during an incremental sync).
 */
export async function* fetchPullRequests(repo: string, log: (msg: string) => void): AsyncGenerator<PullRequest> {
  const [owner, name] = repo.split("/");
  let after: string | null = null;
  do {
    const data: {
      repository: { pullRequests: { pageInfo: PageInfo; nodes: RawPr[] } };
      rateLimit: { remaining: number; resetAt: string };
    } = await graphql(PRS_QUERY, { owner, name, after });
    const { pageInfo, nodes } = data.repository.pullRequests;
    log(`fetched ${nodes.length} PRs (rate limit remaining: ${data.rateLimit.remaining})`);
    for (const pr of nodes) yield await toPullRequest(owner, name, pr);
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after);
}

/** The pull requests whose source branch is `branch` (most recently updated first), with their review threads. */
export async function fetchPullRequestsForBranch(repo: string, branch: string): Promise<PullRequest[]> {
  const [owner, name] = repo.split("/");
  const data = await graphql<{ repository: { pullRequests: { nodes: RawPr[] } } }>(BRANCH_PRS_QUERY, { owner, name, branch });
  return Promise.all(data.repository.pullRequests.nodes.map((pr) => toPullRequest(owner, name, pr)));
}

/** Current resolution state of review threads, by GraphQL node id. Threads that no longer exist are left out. */
export async function fetchThreadStates(threadIds: string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  for (let i = 0; i < threadIds.length; i += 100) {
    const data = await graphql<{ nodes: ({ id: string; isResolved: boolean } | null)[] }>(
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequestReviewThread { id isResolved } } }`,
      { ids: threadIds.slice(i, i + 100) });
    for (const n of data.nodes) if (n?.id) result.set(n.id, n.isResolved);
  }
  return result;
}

/** Resolves or reopens a review thread on GitHub, optionally replying first. Returns the new state. */
export async function setThreadResolved(threadId: string, resolved: boolean, reply?: string): Promise<boolean> {
  if (reply) {
    await graphql(
      `mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { comment { id } } }`,
      { id: threadId, body: reply });
  }
  const mutation = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const data = await graphql<Record<string, { thread: { isResolved: boolean } }>>(
    `mutation($id: ID!) { ${mutation}(input: { threadId: $id }) { thread { isResolved } } }`, { id: threadId });
  return data[mutation].thread.isResolved;
}

/** Reply posted on a GitHub review conversation when its code note is deleted. */
export function githubDeletionReply(reason: string): string {
  return `${reason}\n\n<sub>Resolved from code notes: this conversation was marked as no longer relevant.</sub>`;
}
