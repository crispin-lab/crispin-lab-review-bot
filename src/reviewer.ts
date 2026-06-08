import { z } from "zod";
import type { AppConfig } from "./config.js";
import { buildChangedLineMap, filterFindingsToChangedLines } from "./diff.js";
import { withFingerprints } from "./fingerprint.js";
import { createChatCompletion } from "./openai-client.js";
import { shouldIgnoreFile } from "./review-settings.js";
import type { ChangedFile, ReviewResult, ReviewSettings } from "./types.js";

const reviewSchema = z.object({
  summary: z.string(),
  findings: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().positive().optional(),
      severity: z.enum(["low", "medium", "high"]),
      title: z.string(),
      body: z.string(),
      suggestion: z.string().optional()
    })
  )
});

export async function reviewPullRequest(
  config: AppConfig,
  files: ChangedFile[],
  settings: ReviewSettings
): Promise<ReviewResult> {
  const changedLineMap = buildChangedLineMap(files);
  const reviewableFiles = files
    .filter((file) => file.patch)
    .filter((file) => !shouldIgnoreFile(file.filename, settings))
    .filter((file) => Buffer.byteLength(file.patch ?? "", "utf8") <= settings.maxPatchBytes)
    .slice(0, settings.maxFiles);
  const skippedFiles = files.length - reviewableFiles.length;
  const patchBytes = reviewableFiles.reduce(
    (sum, file) => sum + Buffer.byteLength(file.patch ?? "", "utf8"),
    0
  );

  if (reviewableFiles.length === 0) {
    return {
      summary: "No reviewable changed files were found after applying the default ignore rules.",
      findings: [],
      metadata: {
        reviewedFiles: 0,
        skippedFiles,
        filteredFindings: 0,
        inlineComments: 0,
        model: config.OPENAI_MODEL,
        patchBytes: 0
      }
    };
  }

  const response = await createChatCompletion(config, {
    model: config.OPENAI_MODEL,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a senior code reviewer. Review only changed lines from a pull request diff. Focus on correctness, security, data loss, race conditions, broken edge cases, and missing tests for changed behavior. Do not comment on style, formatting, broad refactors, unchanged code, or speculative improvements. Return concise JSON only."
      },
      {
        role: "user",
        content: buildReviewPrompt(reviewableFiles, settings)
      }
    ]
  });

  const content = response.choices[0]?.message.content;
  if (!content) {
    throw new Error("OpenAI returned an empty review response.");
  }

  const parsed = parseReviewResponse(content);
  const severityFiltered = filterBySeverity(parsed.findings, settings.severityThreshold);
  const changedLineFiltered = filterFindingsToChangedLines(severityFiltered, changedLineMap);

  return {
    summary: parsed.summary,
    findings: withFingerprints(changedLineFiltered.findings.slice(0, settings.maxFindings)),
    metadata: {
      reviewedFiles: reviewableFiles.length,
      skippedFiles,
      filteredFindings:
        parsed.findings.length - severityFiltered.length + changedLineFiltered.filteredCount,
      inlineComments: 0,
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      totalTokens: response.usage?.total_tokens,
      model: response.model,
      patchBytes
    }
  };
}

function parseReviewResponse(content: string): z.infer<typeof reviewSchema> {
  try {
    return reviewSchema.parse(JSON.parse(content));
  } catch (error) {
    throw new Error(`OpenAI returned invalid review JSON: ${error}`);
  }
}

function buildReviewPrompt(files: ChangedFile[], settings: ReviewSettings): string {
  const fileSections = files
    .map((file) => {
      return `File: ${file.filename}
Status: ${file.status}
Additions: ${file.additions}
Deletions: ${file.deletions}
Patch:
\`\`\`diff
${file.patch}
\`\`\`
${file.context ? `\nContext from head version:\n\`\`\`\n${file.context}\n\`\`\`` : ""}`;
    })
    .join("\n\n---\n\n");

  return `Review this pull request diff.

Rules:
- Only report issues that are visible from the diff.
- Only report issues that are actionable and likely to matter.
- Prefer no finding over a weak finding.
- Return at most ${settings.maxFindings} findings.
- Use the changed file path exactly as provided.
- If a precise changed line is visible, include it as "line".
- Focus areas for this repository: ${settings.focus.join(", ")}.
- Minimum severity to report: ${settings.severityThreshold}.

Return JSON with this shape:
{
  "summary": "one or two sentences",
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 123,
      "severity": "low | medium | high",
      "title": "short issue title",
      "body": "why this is a problem",
      "suggestion": "specific fix"
    }
  ]
}

Diff:

${fileSections}`;
}

function filterBySeverity(
  findings: z.infer<typeof reviewSchema>["findings"],
  threshold: ReviewSettings["severityThreshold"]
) {
  const rank = {
    low: 1,
    medium: 2,
    high: 3
  };
  return findings.filter((finding) => rank[finding.severity] >= rank[threshold]);
}
