import { Minimatch } from "minimatch";
import { parse } from "yaml";
import type { Octokit } from "@octokit/rest";
import type { AppConfig } from "./config.js";
import type { PullRequestContext, ReviewSettings } from "./types.js";

const defaultIgnore = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "dist/**",
  "build/**",
  "coverage/**",
  "**/*.min.js",
  "**/*.min.css"
];

type RawReviewSettings = {
  review?: {
    max_files?: number;
    max_findings?: number;
    max_patch_bytes?: number;
    context_lines?: number;
    ignore?: string[];
    focus?: string[];
    skip_drafts?: boolean;
    skip_labels?: string[];
    severity_threshold?: "low" | "medium" | "high";
    inline_comments?: boolean;
    summary_comment?: boolean;
    skip_forks?: boolean;
    fail_on_error?: boolean;
    trusted_users?: string[];
    trusted_associations?: string[];
  };
};

export async function loadReviewSettings(
  octokit: Octokit,
  context: PullRequestContext,
  config: AppConfig
): Promise<ReviewSettings> {
  const fromRepo = await readRepoSettings(octokit, context);
  const review = fromRepo?.review ?? {};

  return {
    maxFiles: review.max_files ?? config.REVIEW_MAX_FILES,
    maxFindings: review.max_findings ?? config.REVIEW_MAX_FINDINGS,
    maxPatchBytes: review.max_patch_bytes ?? config.REVIEW_MAX_PATCH_BYTES,
    contextLines: review.context_lines ?? config.REVIEW_CONTEXT_LINES,
    ignore: [...defaultIgnore, ...(review.ignore ?? [])],
    focus: review.focus ?? ["correctness", "security", "tests"],
    skipDrafts: review.skip_drafts ?? true,
    skipLabels: review.skip_labels ?? ["ai-review:skip"],
    severityThreshold: review.severity_threshold ?? "low",
    inlineComments: review.inline_comments ?? config.REVIEW_INLINE_COMMENTS,
    summaryComment: review.summary_comment ?? config.REVIEW_SUMMARY_COMMENT,
    skipForks: review.skip_forks ?? config.REVIEW_SKIP_FORKS,
    failOnError: review.fail_on_error ?? config.REVIEW_FAIL_ON_ERROR,
    trustedUsers: review.trusted_users ?? splitList(config.REVIEW_TRUSTED_USERS),
    trustedAssociations:
      review.trusted_associations ?? splitList(config.REVIEW_TRUSTED_ASSOCIATIONS)
  };
}

export function shouldIgnoreFile(filename: string, settings: ReviewSettings): boolean {
  return settings.ignore.some((pattern) => {
    const matcher = new Minimatch(pattern, { dot: true, matchBase: !pattern.includes("/") });
    return matcher.match(filename);
  });
}

async function readRepoSettings(
  octokit: Octokit,
  context: PullRequestContext
): Promise<RawReviewSettings | undefined> {
  try {
    const response = await octokit.repos.getContent({
      owner: context.owner,
      repo: context.repo,
      path: ".ai-review.yml",
      ref: context.headSha
    });

    if (Array.isArray(response.data) || response.data.type !== "file" || !response.data.content) {
      return undefined;
    }

    const yaml = Buffer.from(response.data.content, "base64").toString("utf8");
    return parse(yaml) as RawReviewSettings;
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 404
  );
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
