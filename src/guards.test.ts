import assert from "node:assert/strict";
import test from "node:test";
import { canRunTrustedCommand, isForkPullRequest } from "./guards.js";
import type { IssueCommentContext, PullRequestContext, ReviewSettings } from "./types.js";

const settings: ReviewSettings = {
  maxFiles: 20,
  maxFindings: 5,
  maxPatchBytes: 120000,
  contextLines: 80,
  ignore: [],
  focus: [],
  skipDrafts: true,
  skipLabels: [],
  severityThreshold: "low",
  inlineComments: true,
  summaryComment: true,
  skipForks: true,
  failOnError: true,
  trustedUsers: ["trusted-user"],
  trustedAssociations: ["OWNER", "MEMBER"]
};

test("isForkPullRequest detects source repo mismatch", () => {
  const context = {
    headRepoFullName: "someone/fork",
    baseRepoFullName: "org/repo"
  } as PullRequestContext;

  assert.equal(isForkPullRequest(context), true);
});

test("canRunTrustedCommand allows configured users", () => {
  const context = {
    commenter: "trusted-user"
  } as IssueCommentContext;

  assert.equal(canRunTrustedCommand(context, settings), true);
});

test("canRunTrustedCommand allows trusted associations", () => {
  const context = {
    commenter: "member",
    authorAssociation: "MEMBER"
  } as IssueCommentContext;

  assert.equal(canRunTrustedCommand(context, settings), true);
});

test("canRunTrustedCommand rejects unknown users", () => {
  const context = {
    commenter: "stranger",
    authorAssociation: "NONE"
  } as IssueCommentContext;

  assert.equal(canRunTrustedCommand(context, settings), false);
});
