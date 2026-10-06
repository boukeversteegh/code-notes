import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PullRequest, ReviewThread } from "./types.ts";

export const CATEGORIES = [
  "applied", // a change was requested and made, or the remark was withdrawn
  "trivial", // nit, typo, naming, formatting, praise, chit-chat
  "deferred", // explicitly postponed: a ticket, a follow-up PR, "later"
  "declined", // a suggestion was rejected, with a reason
  "explanation", // a question answered with rationale or domain knowledge
  "convention", // states a team rule or guideline
  "unanswered", // a human concern with no visible reply or outcome
  "bot_noise", // automated review that no human engaged with
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * Bounded decisions about a thread. A decision model such as Jev can produce these;
 * `summary` is free text and needs a text-generating model.
 */
export interface Classification {
  category: Category;
  /** Worth showing to someone who opens the file months later. */
  useful: boolean;
  /** The point applies beyond this file (a convention or design rule). */
  general: boolean;
  /** Ticket key referenced as the follow-up, e.g. PROJ-123. */
  ticket: string | null;
  summary: string;
  classifier: string;
  /** Hash of the thread content the classification was made for. */
  hash: string;
}

export interface ThreadInput {
  thread: ReviewThread;
  pr: Pick<PullRequest, "number" | "title" | "state">;
}

const BOTS = new Set(["coderabbitai", "copilot-pull-request-reviewer", "github-actions"]);

export function threadHash({ thread }: ThreadInput): string {
  const content = thread.comments.map((c) => `${c.author}\n${c.body}`).join("\n---\n");
  return createHash("sha1").update(`${PROMPT_VERSION}\n${content}`).digest("hex").slice(0, 16);
}

/** Classifications that need no model: unanswered bot reviews and bare suggestion blocks. */
export function prefilter(input: ThreadInput): Classification | null {
  const { comments } = input.thread;
  const base = { useful: false, general: false, ticket: null, classifier: "prefilter", hash: threadHash(input) };
  if (comments.every((c) => BOTS.has(c.author))) {
    return { ...base, category: "bot_noise", summary: "Automated review comment without a human reply." };
  }
  if (comments.length === 1) {
    const prose = comments[0].body.replace(/```suggestion[\s\S]*?```/g, "").trim();
    if (prose.length < 40 && prose.length < comments[0].body.trim().length) {
      return { ...base, category: "trivial", summary: "Inline code suggestion without discussion." };
    }
  }
  return null;
}

const PROMPT_VERSION = "v2";

const SYSTEM_PROMPT = `You triage GitHub pull-request review conversations for a team that wants to surface past review discussion when a developer reopens a file months later.

Context:
- Some teams resolve every conversation before merging, so "resolved" does not necessarily say anything about the outcome.
- Comments can be in any language, and some may be written by AI agents on behalf of the named person.
- If a suggestion was applied, the code already reflects it, so the conversation is noise for a future reader.

For each conversation decide:
- category, exactly one of:
  - applied: a change was requested and made, or the reviewer withdrew the remark.
  - trivial: nits, typos, naming, formatting, leftover debug code, praise, jokes, chit-chat.
  - deferred: something was explicitly postponed: a ticket was created, a follow-up PR was promised, "later", "separate PR", "out of scope".
  - declined: a suggestion was rejected and a reason was given that explains why the code is the way it is.
  - explanation: a question was answered with rationale, intent or domain knowledge that is not obvious from the code itself.
  - convention: a team rule, guideline or architectural principle is stated.
  - unanswered: a human raised a concern and there is no visible reply or outcome.
  - bot_noise: an automated review with no human engagement.
- useful: true only if a developer opening this file today would learn something they cannot see in the code: an open or postponed follow-up, a reason something was deliberately not done, a non-obvious intent or domain fact, or a convention. Applied changes, trivia and bot noise are never useful. A deferred item or a declined suggestion is useful.
  A single comment without a reply was usually handled silently in a later commit. Mark it useful only if it states a concrete risk, rule or improvement idea together with its reasoning, so that it is worth knowing even if nobody replied. Requests to add a code comment, rename something or tidy up are never useful.
- general: true if the point applies beyond this one file (a convention, a design rule, a pattern to follow or avoid).
- ticket: the Jira key (like PROJ-123) of the follow-up ticket, if one is named as where the deferred work lives; otherwise null.
- summary: one English sentence (max 30 words) stating the substance itself, not the conversation: what was decided, deferred or explained, and why. Good: "Deferred to PROJ-123: replace the remaining direct database calls with the repository, so caching applies everywhere." Bad: "Reviewer suggested a change; follow-up created." For non-useful conversations a short label is enough.

Return one result per conversation, using the conversation's id.`;

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: [...CATEGORIES] },
          useful: { type: "boolean" },
          general: { type: "boolean" },
          ticket: { type: ["string", "null"] },
          summary: { type: "string" },
        },
        required: ["id", "category", "useful", "general", "ticket", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

const MAX_COMMENT_CHARS = 1500;

function cleanBody(body: string): string {
  const text = body
    .replace(/<details>[\s\S]*?<\/details>/g, "") // bot "prompt for AI agents" blocks and analysis chains
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  return text.length > MAX_COMMENT_CHARS ? `${text.slice(0, MAX_COMMENT_CHARS)} […]` : text;
}

function renderThread(id: string, { thread, pr }: ThreadInput): string {
  const facts = [
    `PR #${pr.number} (${pr.state.toLowerCase()}${pr.state === "CLOSED" ? ", never merged" : ""}): ${pr.title}`,
    `File: ${thread.path}`,
    thread.isOutdated ? "The commented code was changed after this conversation started." : "The commented code was not changed afterwards.",
  ];
  const comments = thread.comments.map((c) => `[${c.author}]\n${cleanBody(c.body)}`);
  return `<conversation id="${id}">\n${facts.join("\n")}\n\n${comments.join("\n\n")}\n</conversation>`;
}

/** The Claude Code CLI; uses the user's Claude login, so no API key is needed. */
function claudeExecutable(): string {
  if (process.env.CODE_NOTES_CLAUDE) return process.env.CODE_NOTES_CLAUDE;
  const bundled = join(dirname(process.execPath), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return existsSync(bundled) ? bundled : "claude";
}

interface RawResult { id: string; category: Category; useful: boolean; general: boolean; ticket: string | null; summary: string }

function runClaude(prompt: string, model: string): Promise<RawResult[]> {
  const args = [
    "-p", "--model", model, "--tools", "", "--no-session-persistence",
    "--output-format", "json", "--system-prompt", SYSTEM_PROMPT, "--json-schema", JSON.stringify(SCHEMA),
  ];
  return new Promise((resolve, reject) => {
    // Run outside any repo so no project CLAUDE.md is pulled into the context.
    const child = execFile(claudeExecutable(), args, { cwd: tmpdir(), maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`claude failed: ${err.message}\n${stderr}`));
      const events = JSON.parse(stdout) as { type: string; subtype?: string; structured_output?: { results: RawResult[] }; result?: string }[];
      const result = events.at(-1);
      if (result?.type !== "result" || result.subtype !== "success" || !result.structured_output) {
        return reject(new Error(`claude returned no structured output: ${JSON.stringify(result).slice(0, 500)}`));
      }
      resolve(result.structured_output.results);
    });
    child.stdin!.end(prompt);
  });
}

/** Classifies threads with Claude (via `claude -p`), several per request. */
export async function classifyWithClaude(
  inputs: ThreadInput[],
  opts: { model: string; batchSize: number; concurrency: number; onResult: (input: ThreadInput, c: Classification) => void; log: (msg: string) => void },
): Promise<void> {
  const batches: ThreadInput[][] = [];
  for (let i = 0; i < inputs.length; i += opts.batchSize) batches.push(inputs.slice(i, i + opts.batchSize));
  const classifier = `claude-${opts.model}-${PROMPT_VERSION}`;
  let done = 0;
  const work = async (batch: ThreadInput[]) => {
    const prompt = batch.map((input, i) => renderThread(`t${i}`, input)).join("\n\n");
    let results: RawResult[] = [];
    for (let attempt = 1; attempt <= 2 && results.length === 0; attempt++) {
      try {
        results = await runClaude(prompt, opts.model);
      } catch (err) {
        opts.log(`batch failed (attempt ${attempt}): ${(err as Error).message.slice(0, 300)}`);
      }
    }
    for (const r of results) {
      const input = batch[Number(r.id.replace(/^t/, ""))];
      if (!input) continue;
      const { id: _, ...decision } = r;
      opts.onResult(input, { ...decision, classifier, hash: threadHash(input) });
    }
    done += batch.length;
    opts.log(`classified ${done}/${inputs.length}`);
  };
  const queue = [...batches];
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) await work(batch);
  }));
}

