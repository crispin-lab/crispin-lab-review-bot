import { loadConfig } from "./config.js";
import {
  answerReviewThread,
  explainTarget,
  parseReviewCommand,
  renderHelpComment
} from "./conversation.js";
import { isBotUser, loadGitHubEvent } from "./event.js";
import { canRunTrustedCommand, isForkPullRequest } from "./guards.js";
import {
  createIssueComment,
  createOctokit,
  enrichFilesWithContext,
  getPullRequestContext,
  listChangedFiles,
  listFailedChecks,
  loadIssueCommentContext,
  loadPullRequestContext,
  loadReviewCommentContext,
  postInlineComments,
  replyToReviewComment,
  upsertSummaryComment
} from "./github.js";
import { loadReviewSettings } from "./review-settings.js";
import { reviewPullRequest } from "./reviewer.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const octokit = createOctokit(config.BOT_GITHUB_TOKEN);
  const event = await loadGitHubEvent(config);

  if (isBotUser(event)) {
    console.log("Skipped bot-authored comment event.");
    return;
  }

  if (config.GITHUB_EVENT_NAME === "issue_comment") {
    await handleIssueComment(config, octokit);
    return;
  }

  if (config.GITHUB_EVENT_NAME === "pull_request_review_comment") {
    await handleReviewComment(config, octokit);
    return;
  }

  const context = await loadPullRequestContext(config);
  await runReview(config, octokit, context);
}

async function runReview(
  config: ReturnType<typeof loadConfig>,
  octokit: ReturnType<typeof createOctokit>,
  context: Awaited<ReturnType<typeof loadPullRequestContext>>,
  overrides?: {
    maxFiles?: number;
    maxFindings?: number;
  }
): Promise<void> {
  const settings = await loadReviewSettings(octokit, context, config);
  if (overrides?.maxFiles) {
    settings.maxFiles = overrides.maxFiles;
  }
  if (overrides?.maxFindings) {
    settings.maxFindings = overrides.maxFindings;
  }

  if (settings.skipDrafts && context.draft) {
    console.log(`Skipped draft PR ${context.repositoryFullName}#${context.pullNumber}.`);
    return;
  }

  if (settings.skipForks && isForkPullRequest(context)) {
    console.log(`Skipped fork PR ${context.repositoryFullName}#${context.pullNumber}.`);
    return;
  }

  const skipLabel = context.labels.find((label) => settings.skipLabels.includes(label));
  if (skipLabel) {
    console.log(
      `Skipped ${context.repositoryFullName}#${context.pullNumber} because it has label "${skipLabel}".`
    );
    return;
  }

  const files = await listChangedFiles(octokit, context);
  const filesWithContext = await enrichFilesWithContext(octokit, context, files, settings.contextLines);
  const result = await reviewPullRequest(config, filesWithContext, settings);

  if (settings.inlineComments) {
    const inlineComments = await postInlineComments(octokit, context, result);
    if (result.metadata) {
      result.metadata.inlineComments = inlineComments;
    }
  }

  if (settings.summaryComment) {
    await upsertSummaryComment(octokit, context, config, result);
  }

  console.log(
    `Reviewed ${files.length} changed file(s) for ${context.repositoryFullName}#${context.pullNumber}. Posted ${result.findings.length} finding(s).`
  );
}

async function handleIssueComment(
  config: ReturnType<typeof loadConfig>,
  octokit: ReturnType<typeof createOctokit>
): Promise<void> {
  const commentContext = await loadIssueCommentContext(config);
  if (!commentContext) {
    console.log("Skipped issue_comment event because it is not on a PR.");
    return;
  }

  const command = parseReviewCommand(commentContext.commentBody);
  if (command.type === "none") {
    console.log("Skipped issue_comment event because it does not contain an ai-review command.");
    return;
  }

  const prContext = await getPullRequestContext(octokit, commentContext);
  const settings = await loadReviewSettings(octokit, prContext, config);
  if (!canRunTrustedCommand(commentContext, settings)) {
    await createIssueComment(
      octokit,
      prContext,
      "I can only run AI review commands for trusted repository members or configured trusted users."
    );
    return;
  }

  if (command.type === "help") {
    await createIssueComment(octokit, prContext, renderHelpComment());
    return;
  }

  if (command.type === "ignore") {
    await createIssueComment(
      octokit,
      prContext,
      "Add the `ai-review:skip` label to skip automatic reviews for this PR."
    );
    return;
  }

  if (command.type === "explain") {
    const files = await listChangedFiles(octokit, prContext);
    const filesWithContext = await enrichFilesWithContext(octokit, prContext, files, settings.contextLines);
    const explanation = await explainTarget(config, prContext, filesWithContext, command.target);
    await createIssueComment(octokit, prContext, explanation);
    return;
  }

  if (command.type === "ci") {
    const failedChecks = await listFailedChecks(octokit, prContext);
    const body = failedChecks.length
      ? `Failed checks for \`${prContext.headSha.slice(0, 7)}\`:\n\n${failedChecks
          .map((check) => `- **${check.name}**: ${check.conclusion}${check.url ? ` (${check.url})` : ""}`)
          .join("\n")}`
      : `No failed checks found for \`${prContext.headSha.slice(0, 7)}\`.`;
    await createIssueComment(octokit, prContext, body);
    return;
  }

  await createIssueComment(
    octokit,
    prContext,
    command.full ? "Running a full AI review for this PR." : "Running an AI review for this PR."
  );
  await runReview(
    config,
    octokit,
    prContext,
    command.full
      ? {
          maxFiles: 60,
          maxFindings: 12
        }
      : undefined
  );
}

async function handleReviewComment(
  config: ReturnType<typeof loadConfig>,
  octokit: ReturnType<typeof createOctokit>
): Promise<void> {
  const context = await loadReviewCommentContext(config);
  if (!context) {
    console.log("Skipped review comment event because required context is missing.");
    return;
  }

  const mentionsBot = config.REVIEW_BOT_MENTIONS.split(",").some((mention) =>
    context.commentBody.toLowerCase().includes(`@${mention.trim().toLowerCase()}`)
  );
  const asksAiReview = /\/ai-review\b/i.test(context.commentBody);
  if (!mentionsBot && !asksAiReview) {
    console.log("Skipped review comment because it does not mention the review bot.");
    return;
  }

  const prContext = await getPullRequestContext(octokit, context);
  const settings = await loadReviewSettings(octokit, prContext, config);
  if (!canRunTrustedCommand(context, settings)) {
    await replyToReviewComment(
      octokit,
      context,
      "I can only respond to AI review thread commands from trusted repository members or configured trusted users."
    );
    return;
  }

  const answer = await answerReviewThread(config, context);
  await replyToReviewComment(octokit, context, answer);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = process.env.REVIEW_FAIL_ON_ERROR === "false" ? 0 : 1;
});
