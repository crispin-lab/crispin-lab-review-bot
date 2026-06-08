export type PullRequestContext = {
  owner: string;
  repo: string;
  pullNumber: number;
  repositoryFullName: string;
  headSha: string;
  headRepoFullName?: string;
  baseRepoFullName?: string;
  draft: boolean;
  labels: string[];
  authorAssociation?: string;
};

export type IssueCommentContext = {
  owner: string;
  repo: string;
  repositoryFullName: string;
  pullNumber: number;
  commentId: number;
  commentBody: string;
  commenter: string;
  authorAssociation?: string;
};

export type ReviewCommentContext = {
  owner: string;
  repo: string;
  repositoryFullName: string;
  pullNumber: number;
  commentId: number;
  commentBody: string;
  commenter: string;
  authorAssociation?: string;
  path: string;
  line?: number;
  diffHunk?: string;
  inReplyToId?: number;
};

export type ChangedFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  context?: string;
};

export type Finding = {
  file: string;
  line?: number;
  severity: "low" | "medium" | "high";
  title: string;
  body: string;
  suggestion?: string;
  fingerprint?: string;
};

export type ReviewResult = {
  summary: string;
  findings: Finding[];
  metadata?: {
    reviewedFiles: number;
    skippedFiles: number;
    filteredFindings: number;
    inlineComments: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    model?: string;
    patchBytes?: number;
  };
};

export type ReviewSettings = {
  maxFiles: number;
  maxFindings: number;
  maxPatchBytes: number;
  ignore: string[];
  focus: string[];
  skipDrafts: boolean;
  skipLabels: string[];
  severityThreshold: "low" | "medium" | "high";
  inlineComments: boolean;
  summaryComment: boolean;
  contextLines: number;
  skipForks: boolean;
  failOnError: boolean;
  trustedUsers: string[];
  trustedAssociations: string[];
};
