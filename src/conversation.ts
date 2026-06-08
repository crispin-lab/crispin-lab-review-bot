import type { AppConfig } from "./config.js";
import { createChatCompletion } from "./openai-client.js";
import type { ChangedFile, PullRequestContext, ReviewCommentContext } from "./types.js";

export type ReviewCommand =
  | { type: "review"; full: boolean }
  | { type: "explain"; target: string }
  | { type: "ci" }
  | { type: "help" }
  | { type: "ignore" }
  | { type: "none" };

export function parseReviewCommand(body: string): ReviewCommand {
  const trimmed = body.trim();
  const firstLine = trimmed.split("\n")[0]?.trim() ?? "";
  const match = firstLine.match(/^\/ai-review(?:\s+(.+))?$/i);

  if (!match) {
    return { type: "none" };
  }

  const args = match[1]?.trim() ?? "";
  if (!args) {
    return { type: "review", full: false };
  }

  if (args === "full") {
    return { type: "review", full: true };
  }

  if (args === "help") {
    return { type: "help" };
  }

  if (args === "ci") {
    return { type: "ci" };
  }

  if (args === "ignore" || args === "skip") {
    return { type: "ignore" };
  }

  const explainMatch = args.match(/^explain\s+(.+)$/i);
  if (explainMatch?.[1]) {
    return { type: "explain", target: explainMatch[1].trim() };
  }

  return { type: "help" };
}

export function renderHelpComment(): string {
  return `Supported commands:

- \`/ai-review\`: rerun the normal review
- \`/ai-review full\`: rerun with a larger review budget
- \`/ai-review explain <file>:<line>\`: explain a specific changed area
- \`/ai-review ci\`: summarize failed checks for the PR head commit
- \`/ai-review help\`: show this help

Use the \`ai-review:skip\` label to skip automatic reviews.`;
}

export async function explainTarget(
  config: AppConfig,
  context: PullRequestContext,
  files: ChangedFile[],
  target: string
): Promise<string> {
  const file = findTargetFile(files, target);
  if (!file?.patch) {
    return `I could not find \`${target}\` in this PR diff.`;
  }

  const response = await createChatCompletion(config, {
    model: config.OPENAI_MODEL,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content:
          "You explain pull request diffs to developers. Be concise, concrete, and avoid speculation beyond the provided diff."
      },
      {
        role: "user",
        content: `Repository: ${context.repositoryFullName}
PR: #${context.pullNumber}
Target: ${target}

Explain the relevant change and any review concern visible from this diff.

\`\`\`diff
${file.patch}
\`\`\``
      }
    ]
  });

  return response.choices[0]?.message.content?.trim() || "I could not generate an explanation.";
}

export async function answerReviewThread(
  config: AppConfig,
  context: ReviewCommentContext
): Promise<string> {
  const response = await createChatCompletion(config, {
    model: config.OPENAI_MODEL,
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content:
          "You are an AI code review bot responding in a GitHub review thread. Answer the developer's question directly. If the concern is invalid, say so and explain why. Keep it concise."
      },
      {
        role: "user",
        content: `Repository: ${context.repositoryFullName}
PR: #${context.pullNumber}
File: ${context.path}
Line: ${context.line ?? "unknown"}

Diff hunk:
\`\`\`diff
${context.diffHunk ?? "not available"}
\`\`\`

Developer comment:
${context.commentBody}`
      }
    ]
  });

  return response.choices[0]?.message.content?.trim() || "I could not generate a useful reply.";
}

function findTargetFile(files: ChangedFile[], target: string): ChangedFile | undefined {
  const path = target.replace(/:\d+$/, "");
  return files.find((file) => file.filename === path || file.filename.endsWith(`/${path}`));
}
