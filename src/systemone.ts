import { CATEGORIES, type Category, type Classification, type ThreadInput, threadHash } from "./classify.ts";

/**
 * Classifier for OpenRouter's System One endpoint (decision models such as Jev and Mercury Decide).
 * These models pick from predefined answers with a probability; they cannot write text,
 * so `summary` stays empty and `ticket` is extracted with a pattern.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/systemone";

type QuestionSet = "v1" | "v2";

/** Classifier name -> model and question set. v1 asks category and usefulness separately; v2 asks one keep/drop outcome. */
export const SYSTEM_ONE_CLASSIFIERS: Record<string, { model: string; questions: QuestionSet }> = {
  jev: { model: "typesafe/jev-1.13", questions: "v1" },
  mercury: { model: "inception/mercury-decide:free", questions: "v1" },
  "jev-v2": { model: "typesafe/jev-1.13", questions: "v2" },
  "mercury-v2": { model: "inception/mercury-decide:free", questions: "v2" },
};

const TEAM_CONTEXT =
  "Context: some teams resolve every review conversation before merging, so being resolved does not necessarily say anything about the outcome. " +
  "Comments can be in any language, and some may be written by AI agents on behalf of the named person. " +
  "If a suggestion was applied, the code already reflects it.";

const CATEGORY_CRITERIA: Record<Category, string> = {
  applied: "A change was requested and made, or the reviewer withdrew the remark.",
  trivial: "Nits, typos, naming, formatting, leftover debug code, praise, jokes or chit-chat.",
  deferred: "Something was explicitly postponed: a ticket was created, a follow-up PR was promised, 'later', 'separate PR', 'out of scope'.",
  declined: "A suggestion was rejected and a reason was given that explains why the code is the way it is.",
  explanation: "A question was answered with rationale, intent or domain knowledge that is not obvious from the code itself.",
  convention: "A team rule, guideline or architectural principle is stated.",
  unanswered: "A human raised a concern and there is no visible reply or outcome.",
  bot_noise: "An automated review that no human engaged with.",
};

const QUESTIONS = {
  category: {
    type: "choice",
    instructions: `${TEAM_CONTEXT} Which outcome best describes this pull-request review conversation?`,
    criteria: CATEGORY_CRITERIA,
  },
  useful: {
    type: "noul",
    instructions: `${TEAM_CONTEXT} Would a developer who opens this file months later learn something from this conversation that they cannot see in the code?`,
    criteria: {
      true: "Yes: an open or postponed follow-up, a reason something was deliberately not done, a non-obvious intent or domain fact, or a team convention.",
      false: "No: the suggestion was applied, it is trivia, it is unanswered bot output, or it is a request (add a comment, rename, tidy up) that was probably handled silently.",
    },
  },
  general: {
    type: "noul",
    instructions: "Does the point of this conversation apply beyond this one file?",
    criteria: {
      true: "It states a convention, design rule, or a pattern to follow or avoid elsewhere.",
      false: "It is specific to this file or change.",
    },
  },
} as const;

/**
 * One choice whose options already decide keep or drop, so the answers cannot contradict each other.
 * Each option gives short examples of typical phrasing.
 */
const OUTCOMES: Record<string, { category: Category; keep: boolean; criterion: string }> = {
  keep_open_followup: {
    category: "deferred", keep: true,
    criterion: "Work was explicitly postponed: a ticket was created ('created PROJ-123 for this', 'Follow-up tracked: PROJ-456'), a follow-up PR was promised ('I will do this in a separate PR'), or it was called later or out of scope, and the conversation does not show it as done.",
  },
  keep_declined_with_reason: {
    category: "declined", keep: true,
    criterion: "A suggestion was not adopted and the reply gives the reason, e.g. 'disagree, the test covers the referenced bug' or 'we still need this to keep the public API working'.",
  },
  keep_explanation: {
    category: "explanation", keep: true,
    criterion: "A question about why the code is the way it is was answered with intent or domain knowledge a reader would otherwise wonder about, e.g. 'that is intended: the reverse option flips the row order' or 'these are the values that are prefilled in the form'.",
  },
  keep_convention: {
    category: "convention", keep: true,
    criterion: "A reviewer states a rule or principle that applies beyond these lines, e.g. 'from now on we call this an export, not a template' or 'test helpers should be composable; do not add one-off utilities to work around lint rules'.",
  },
  keep_unanswered_risk: {
    category: "unanswered", keep: true,
    criterion: "A comment without a reply that names a concrete risk, bug or improvement together with its reasoning, worth knowing even though nobody answered.",
  },
  drop_applied: {
    category: "applied", keep: false,
    criterion: "A change was requested and made or agreed to ('fixed', 'done', 'updated', 'good point', 'removed', 'Fixed in <commit>'), or the reviewer withdrew the remark.",
  },
  drop_trivial: {
    category: "trivial", keep: false,
    criterion: "Nits, typos, naming tweaks, formatting, leftover debug code, praise, jokes or chit-chat.",
  },
  drop_unanswered_request: {
    category: "unanswered", keep: false,
    criterion: "A single comment asking to add a comment, rename, remove or tidy something, or a small code suggestion, with no reply; most likely handled silently.",
  },
  drop_bot: {
    category: "bot_noise", keep: false,
    criterion: "Automated review output (for example coderabbitai) that no human engaged with.",
  },
};

const QUESTIONS_V2 = {
  outcome: {
    type: "choice",
    instructions: `${TEAM_CONTEXT} Classify the outcome of this pull-request review conversation, from the point of view of a developer who opens this file months later: is there something worth knowing that the code itself does not show?`,
    criteria: Object.fromEntries(Object.entries(OUTCOMES).map(([k, o]) => [k, o.criterion])),
  },
  general: QUESTIONS.general,
} as const;

const MAX_COMMENT_CHARS = 1500;

function toState({ thread, pr }: ThreadInput) {
  return {
    pull_request: `#${pr.number} (${pr.state.toLowerCase()}${pr.state === "CLOSED" ? ", never merged" : ""}): ${pr.title}`,
    file: thread.path,
    code_changed_after_conversation: thread.isOutdated,
    comments: thread.comments.map((c) => {
      const text = c.body.replace(/<details>[\s\S]*?<\/details>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
      return { author: c.author, text: text.length > MAX_COMMENT_CHARS ? `${text.slice(0, MAX_COMMENT_CHARS)} […]` : text };
    }),
  };
}

interface Answers {
  category?: { choice: string; confidence: number };
  useful?: { noul: number };
  outcome?: { choice: string; confidence: number; probabilities: Record<string, number> };
  general: { noul: number };
}

async function decide(model: string, questions: QuestionSet, input: ThreadInput, apiKey: string): Promise<Answers> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, state: toState(input), questions: questions === "v2" ? QUESTIONS_V2 : QUESTIONS }),
    });
    if (res.ok) return ((await res.json()) as { answers: Answers }).answers;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 5) throw new Error(`System One ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

export interface SystemOneClassification extends Classification {
  /** Probability that the thread is useful, as reported by the model. */
  usefulProbability: number;
  categoryConfidence: number;
}

/** Classifies each thread with one System One request. `useful` is the model's probability above `threshold`. */
export async function classifyWithSystemOne(
  inputs: ThreadInput[],
  opts: { classifier: string; concurrency: number; threshold: number; onResult: (input: ThreadInput, c: SystemOneClassification) => void; log: (msg: string) => void },
): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set.");
  const { model, questions } = SYSTEM_ONE_CLASSIFIERS[opts.classifier];
  let done = 0;
  const queue = [...inputs];
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    for (let input = queue.shift(); input; input = queue.shift()) {
      try {
        const a = await decide(model, questions, input, apiKey);
        let category: Category, usefulProbability: number, categoryConfidence: number;
        if (a.outcome) {
          // Usefulness is the total probability of the keep outcomes.
          category = OUTCOMES[a.outcome.choice]?.category ?? "unanswered";
          usefulProbability = Object.entries(a.outcome.probabilities).reduce((sum, [k, p]) => sum + (OUTCOMES[k]?.keep ? p : 0), 0);
          categoryConfidence = a.outcome.confidence;
        } else {
          const choice = a.category!.choice;
          category = (CATEGORIES as readonly string[]).includes(choice) ? (choice as Category) : "unanswered";
          usefulProbability = a.useful!.noul;
          categoryConfidence = a.category!.confidence;
        }
        const text = input.thread.comments.map((c) => c.body).join("\n");
        opts.onResult(input, {
          category,
          useful: usefulProbability >= opts.threshold,
          general: a.general.noul >= 0.5,
          ticket: category === "deferred" ? (text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g)?.at(-1) ?? null) : null,
          summary: "",
          classifier: `systemone-${model}-${questions}`,
          hash: threadHash(input),
          usefulProbability,
          categoryConfidence,
        });
      } catch (err) {
        opts.log(`thread ${input.thread.id} failed: ${(err as Error).message}`);
      }
      if (++done % 50 === 0) opts.log(`classified ${done}/${inputs.length}`);
    }
  }));
}
