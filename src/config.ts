import { z } from "zod";

const envBoolean = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  if (value.toLowerCase() === "true") {
    return true;
  }

  if (value.toLowerCase() === "false") {
    return false;
  }

  return value;
}, z.boolean());

const envSchema = z.object({
  BOT_GITHUB_TOKEN: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  GITHUB_REPOSITORY: z.string().min(1),
  GITHUB_EVENT_PATH: z.string().min(1),
  GITHUB_EVENT_NAME: z.string().min(1).default("pull_request"),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_FALLBACK_MODEL: z.string().default("gpt-4o-mini"),
  REVIEW_MAX_FILES: z.coerce.number().int().positive().default(20),
  REVIEW_MAX_FINDINGS: z.coerce.number().int().positive().default(5),
  REVIEW_MAX_PATCH_BYTES: z.coerce.number().int().positive().default(120_000),
  REVIEW_CONTEXT_LINES: z.coerce.number().int().nonnegative().default(80),
  REVIEW_INLINE_COMMENTS: envBoolean.default(true),
  REVIEW_SUMMARY_COMMENT: envBoolean.default(true),
  REVIEW_SKIP_FORKS: envBoolean.default(true),
  REVIEW_FAIL_ON_ERROR: envBoolean.default(true),
  REVIEW_TRUSTED_USERS: z.string().default(""),
  REVIEW_TRUSTED_ASSOCIATIONS: z.string().default("OWNER,MEMBER,COLLABORATOR"),
  REVIEW_BOT_MENTIONS: z.string().default("ai-review-bot,review-bot,crispin-lab-review-bot"),
  REVIEW_COMMENT_MARKER: z.string().default("<!-- crispin-lab-review-bot:summary -->")
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Missing or invalid environment:\n${details}`);
  }

  return parsed.data;
}
