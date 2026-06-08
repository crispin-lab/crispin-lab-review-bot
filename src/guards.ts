import type { IssueCommentContext, PullRequestContext, ReviewCommentContext, ReviewSettings } from "./types.js";

export function isForkPullRequest(context: PullRequestContext): boolean {
  return Boolean(
    context.headRepoFullName &&
      context.baseRepoFullName &&
      context.headRepoFullName !== context.baseRepoFullName
  );
}

export function canRunTrustedCommand(
  actor: IssueCommentContext | ReviewCommentContext,
  settings: ReviewSettings
): boolean {
  if (settings.trustedUsers.includes(actor.commenter)) {
    return true;
  }

  return Boolean(
    actor.authorAssociation &&
      settings.trustedAssociations
        .map((association) => association.toUpperCase())
        .includes(actor.authorAssociation.toUpperCase())
  );
}
