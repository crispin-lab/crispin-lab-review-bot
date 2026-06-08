import { Octokit } from "@octokit/rest";
import { parseChangedLines } from "./diff.js";
import { loadGitHubEvent, splitRepository, type GitHubEventPayload } from "./event.js";
import { renderFingerprintMarker } from "./fingerprint.js";
import type {
  ChangedFile,
  Finding,
  IssueCommentContext,
  PullRequestContext,
  ReviewCommentContext,
  ReviewResult
} from "./types.js";
import type { AppConfig } from "./config.js";

export function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

export async function loadPullRequestContext(config: AppConfig): Promise<PullRequestContext> {
  const event = await loadGitHubEvent(config);
  return pullRequestContextFromEvent(config, event);
}

export function pullRequestContextFromEvent(
  config: AppConfig,
  event: GitHubEventPayload
): PullRequestContext {
  const repositoryFullName = event.repository?.full_name ?? config.GITHUB_REPOSITORY;
  const { owner, repo } = splitRepository(repositoryFullName);
  const pullNumber = event.pull_request?.number;
  const headSha = event.pull_request?.head?.sha;

  if (!owner || !repo || !pullNumber || !headSha) {
    throw new Error("This reviewer must run from a pull_request GitHub Actions event.");
  }

  return {
    owner,
    repo,
    pullNumber,
    repositoryFullName,
    headSha,
    headRepoFullName: event.pull_request?.head?.repo?.full_name,
    baseRepoFullName: event.pull_request?.base?.repo?.full_name,
    draft: event.pull_request?.draft ?? false,
    labels: event.pull_request?.labels?.flatMap((label) => (label.name ? [label.name] : [])) ?? [],
    authorAssociation: undefined
  };
}

export async function loadIssueCommentContext(
  config: AppConfig
): Promise<IssueCommentContext | undefined> {
  const event = await loadGitHubEvent(config);
  if (!event.issue?.pull_request || !event.comment?.id) {
    return undefined;
  }

  const repositoryFullName = event.repository?.full_name ?? config.GITHUB_REPOSITORY;
  const { owner, repo } = splitRepository(repositoryFullName);

  return {
    owner,
    repo,
    repositoryFullName,
    pullNumber: event.issue.number,
    commentId: event.comment.id,
    commentBody: event.comment.body ?? "",
    commenter: event.comment.user?.login ?? "unknown",
    authorAssociation: event.comment.author_association ?? event.issue.author_association
  };
}

export async function loadReviewCommentContext(
  config: AppConfig
): Promise<ReviewCommentContext | undefined> {
  const event = await loadGitHubEvent(config);
  if (!event.comment?.id || !event.pull_request?.number || !event.comment.path) {
    return undefined;
  }

  const repositoryFullName = event.repository?.full_name ?? config.GITHUB_REPOSITORY;
  const { owner, repo } = splitRepository(repositoryFullName);

  return {
    owner,
    repo,
    repositoryFullName,
    pullNumber: event.pull_request.number,
    commentId: event.comment.id,
    commentBody: event.comment.body ?? "",
    commenter: event.comment.user?.login ?? "unknown",
    authorAssociation: event.comment.author_association,
    path: event.comment.path,
    line: event.comment.line,
    diffHunk: event.comment.diff_hunk,
    inReplyToId: event.comment.in_reply_to_id
  };
}

export async function getPullRequestContext(
  octokit: Octokit,
  context: Pick<PullRequestContext, "owner" | "repo" | "pullNumber" | "repositoryFullName">
): Promise<PullRequestContext> {
  const response = await octokit.pulls.get({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber
  });
  const pr = response.data;

  return {
    owner: context.owner,
    repo: context.repo,
    pullNumber: context.pullNumber,
    repositoryFullName: context.repositoryFullName,
    headSha: pr.head.sha,
    headRepoFullName: pr.head.repo?.full_name,
    baseRepoFullName: pr.base.repo?.full_name,
    draft: pr.draft ?? false,
    labels: pr.labels.flatMap((label) =>
      typeof label === "string" ? [label] : label.name ? [label.name] : []
    ),
    authorAssociation: pr.author_association
  };
}

export async function listChangedFiles(
  octokit: Octokit,
  context: PullRequestContext
): Promise<ChangedFile[]> {
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
    per_page: 100
  });

  return files.map((file) => ({
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch
  }));
}

export async function enrichFilesWithContext(
  octokit: Octokit,
  context: PullRequestContext,
  files: ChangedFile[],
  contextLines: number
): Promise<ChangedFile[]> {
  if (contextLines <= 0) {
    return files;
  }

  return Promise.all(
    files.map(async (file) => {
      if (!file.patch) {
        return file;
      }

      const changedLines = Array.from(parseChangedLines(file.patch)).sort((a, b) => a - b);
      if (changedLines.length === 0) {
        return file;
      }

      try {
        const response = await octokit.repos.getContent({
          owner: context.owner,
          repo: context.repo,
          path: file.filename,
          ref: context.headSha
        });

        if (Array.isArray(response.data) || response.data.type !== "file" || !response.data.content) {
          return file;
        }

        const content = Buffer.from(response.data.content, "base64").toString("utf8");
        return {
          ...file,
          context: renderFileContext(content, changedLines, contextLines)
        };
      } catch {
        return file;
      }
    })
  );
}

export async function upsertSummaryComment(
  octokit: Octokit,
  context: PullRequestContext,
  config: AppConfig,
  result: ReviewResult
): Promise<void> {
  const body = renderSummaryComment(config.REVIEW_COMMENT_MARKER, result);
  const comments = await octokit.paginate(octokit.issues.listComments, {
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullNumber,
    per_page: 100
  });
  const existing = comments.find((comment) => comment.body?.includes(config.REVIEW_COMMENT_MARKER));

  if (existing) {
    await octokit.issues.updateComment({
      owner: context.owner,
      repo: context.repo,
      comment_id: existing.id,
      body
    });
    return;
  }

  await octokit.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullNumber,
    body
  });
}

export async function createIssueComment(
  octokit: Octokit,
  context: Pick<PullRequestContext, "owner" | "repo" | "pullNumber">,
  body: string
): Promise<void> {
  await octokit.issues.createComment({
    owner: context.owner,
    repo: context.repo,
    issue_number: context.pullNumber,
    body
  });
}

export async function replyToReviewComment(
  octokit: Octokit,
  context: ReviewCommentContext,
  body: string
): Promise<void> {
  await octokit.pulls.createReplyForReviewComment({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
    comment_id: context.commentId,
    body
  });
}

export async function listFailedChecks(
  octokit: Octokit,
  context: PullRequestContext
): Promise<Array<{ name: string; conclusion: string; url?: string }>> {
  const response = await octokit.checks.listForRef({
    owner: context.owner,
    repo: context.repo,
    ref: context.headSha,
    per_page: 100
  });

  return response.data.check_runs
    .filter((check) =>
      ["failure", "timed_out", "cancelled", "action_required"].includes(check.conclusion ?? "")
    )
    .map((check) => ({
      name: check.name,
      conclusion: check.conclusion ?? "unknown",
      url: check.html_url ?? undefined
    }));
}

export async function postInlineComments(
  octokit: Octokit,
  context: PullRequestContext,
  result: ReviewResult
): Promise<number> {
  const inlineFindings = result.findings.filter(
    (finding): finding is Finding & { line: number; fingerprint: string } =>
      Boolean(finding.line && finding.fingerprint)
  );

  if (inlineFindings.length === 0) {
    return 0;
  }

  const existingFingerprints = await listExistingFindingFingerprints(octokit, context);
  const comments = inlineFindings
    .filter((finding) => !existingFingerprints.has(finding.fingerprint))
    .map((finding) => ({
      path: finding.file,
      line: finding.line,
      side: "RIGHT" as const,
      body: renderInlineComment(finding)
    }));

  if (comments.length === 0) {
    return 0;
  }

  await octokit.pulls.createReview({
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
    commit_id: context.headSha,
    event: "COMMENT",
    body: "AI review findings on changed lines.",
    comments
  });

  return comments.length;
}

function renderSummaryComment(marker: string, result: ReviewResult): string {
  const findings = result.findings.length
    ? result.findings
        .map((finding, index) => {
          const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
          const markerLine = finding.fingerprint
            ? `\n\n   ${renderFingerprintMarker(finding.fingerprint)}`
            : "";
          const suggestion = finding.suggestion ? `\n\n   Suggested fix: ${finding.suggestion}` : "";
          return `${index + 1}. **${finding.severity.toUpperCase()}** ${finding.title}\n\n   \`${location}\`\n\n   ${finding.body}${suggestion}${markerLine}`;
        })
        .join("\n\n")
    : "No concrete issues found in the changed lines.";

  const metadata = result.metadata
    ? `
### Run details

- Reviewed files: ${result.metadata.reviewedFiles}
- Skipped files: ${result.metadata.skippedFiles}
- Filtered findings outside changed lines: ${result.metadata.filteredFindings}
- Inline comments posted: ${result.metadata.inlineComments}
- Model: ${result.metadata.model ?? "unknown"}
- Patch bytes reviewed: ${result.metadata.patchBytes ?? 0}
- Tokens: ${result.metadata.totalTokens ?? "unknown"} total (${result.metadata.promptTokens ?? "unknown"} prompt, ${result.metadata.completionTokens ?? "unknown"} completion)
`
    : "";

  return `${marker}
## AI Review

${result.summary}

### Findings

${findings}
${metadata}
`;
}

function renderFileContext(content: string, changedLines: number[], contextLines: number): string {
  const lines = content.split("\n");
  const minLine = Math.max(1, Math.min(...changedLines) - contextLines);
  const maxLine = Math.min(lines.length, Math.max(...changedLines) + contextLines);

  return lines
    .slice(minLine - 1, maxLine)
    .map((line, index) => `${minLine + index}: ${line}`)
    .join("\n");
}

async function listExistingFindingFingerprints(
  octokit: Octokit,
  context: PullRequestContext
): Promise<Set<string>> {
  const comments = await octokit.paginate(octokit.pulls.listReviewComments, {
    owner: context.owner,
    repo: context.repo,
    pull_number: context.pullNumber,
    per_page: 100
  });
  const fingerprints = new Set<string>();

  for (const comment of comments) {
    for (const fingerprint of extractFindingFingerprints(comment.body)) {
      fingerprints.add(fingerprint);
    }
  }

  return fingerprints;
}

function renderInlineComment(finding: Finding & { fingerprint: string }): string {
  const suggestion = finding.suggestion ? `\n\nSuggested fix: ${finding.suggestion}` : "";
  return `**${finding.severity.toUpperCase()}** ${finding.title}

${finding.body}${suggestion}

${renderFingerprintMarker(finding.fingerprint)}`;
}

function extractFindingFingerprints(body: string | undefined): string[] {
  if (!body) {
    return [];
  }

  return Array.from(body.matchAll(/crispin-lab-review-bot:finding:([a-f0-9]{16})/g)).map(
    (match) => match[1]
  );
}
