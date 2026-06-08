import { readFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";

export type GitHubEventPayload = {
  action?: string;
  pull_request?: {
    number: number;
    draft?: boolean;
    head?: {
      sha?: string;
      repo?: {
        full_name?: string;
      };
    };
    base?: {
      repo?: {
        full_name?: string;
      };
    };
    labels?: Array<{
      name?: string;
    }>;
  };
  issue?: {
    number: number;
    pull_request?: unknown;
    author_association?: string;
  };
  comment?: {
    id: number;
    body?: string;
    user?: {
      login?: string;
      type?: string;
    };
    author_association?: string;
    path?: string;
    line?: number;
    diff_hunk?: string;
    in_reply_to_id?: number;
    pull_request_review_id?: number;
  };
  repository?: {
    full_name: string;
  };
};

export async function loadGitHubEvent(config: AppConfig): Promise<GitHubEventPayload> {
  const raw = await readFile(config.GITHUB_EVENT_PATH, "utf8");
  return JSON.parse(raw) as GitHubEventPayload;
}

export function splitRepository(fullName: string): { owner: string; repo: string } {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repository full name: ${fullName}`);
  }
  return { owner, repo };
}

export function isBotUser(payload: GitHubEventPayload): boolean {
  const user = payload.comment?.user;
  return user?.type === "Bot" || Boolean(user?.login?.endsWith("[bot]"));
}
