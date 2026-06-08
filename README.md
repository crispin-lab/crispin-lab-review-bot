# Crispin Lab Review Bot

Reusable GitHub Actions based AI reviewer for repositories in the `crispin-lab` organization.

## How it works

Target repositories call this repository's reusable workflow on pull request events. The workflow:

1. Reads the pull request changed files through the GitHub API.
2. Loads optional repository settings from `.ai-review.yml`.
3. Sends reviewable diffs to OpenAI.
4. Keeps only concrete findings on changed lines.
5. Posts inline comments for line-level findings.
6. Creates or updates one PR summary comment using the review bot GitHub account token.

The first version intentionally posts a single summary comment instead of inline comments. Inline comments require diff-position mapping and should be added after the basic reviewer is stable.

## Bot account setup

Create a fine-grained personal access token from the review bot GitHub account.

Required repository access:

- This review bot repository
- Frontend repository
- Backend repository

Required permissions:

- Metadata: read
- Contents: read
- Pull requests: read
- Issues: read and write

Store these secrets in each target repository:

- `REVIEW_BOT_GITHUB_TOKEN`: fine-grained PAT from the bot account
- `OPENAI_API_KEY`: OpenAI API key

## Target repository workflow

Add this file to each frontend/backend repository as `.github/workflows/ai-review.yml`.

If this review bot repository is private, enable reusable workflow access in the review bot repository settings:

- Settings
- Actions
- General
- Access
- Accessible from repositories in the `crispin-lab` organization

```yaml
name: AI Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: read

jobs:
  review:
    uses: crispin-lab/crispin-lab-review-bot/.github/workflows/review.yml@main
    secrets:
      BOT_GITHUB_TOKEN: ${{ secrets.REVIEW_BOT_GITHUB_TOKEN }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Optional tuning:

```yaml
jobs:
  review:
    uses: crispin-lab/crispin-lab-review-bot/.github/workflows/review.yml@main
    with:
      openai_model: gpt-4o-mini
      openai_fallback_model: gpt-4o-mini
      max_files: 20
      max_findings: 5
      max_patch_bytes: 120000
      context_lines: 80
      inline_comments: true
      summary_comment: true
      bot_mentions: your-review-bot
      skip_forks: true
      fail_on_error: true
    secrets:
      BOT_GITHUB_TOKEN: ${{ secrets.REVIEW_BOT_GITHUB_TOKEN }}
      OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Repository settings

Each target repository can add `.ai-review.yml` to tune the reviewer.

```yaml
review:
  max_files: 30
  max_findings: 5
  max_patch_bytes: 120000
  context_lines: 80
  severity_threshold: low
  inline_comments: true
  summary_comment: true
  skip_forks: true
  fail_on_error: true
  trusted_users:
    - crispin
  trusted_associations:
    - OWNER
    - MEMBER
    - COLLABORATOR
  skip_drafts: true
  skip_labels:
    - ai-review:skip
  ignore:
    - generated/**
    - "**/*.snap"
  focus:
    - correctness
    - security
    - tests
```

The bot always ignores common lockfiles, build outputs, coverage outputs, and minified assets. Findings with a line number are filtered out unless the line is part of the PR diff.

Inline comments are deduplicated with hidden finding fingerprints, so rerunning the workflow does not repost the same issue. Findings without a precise line stay in the summary comment only.

The summary comment includes the model, reviewed patch bytes, token usage, skipped file count, filtered finding count, and inline comment count. OpenAI calls retry automatically and can fall back to `openai_fallback_model`.

## PR comment commands

The bot can respond to PR comments:

- `/ai-review`: rerun the normal review
- `/ai-review full`: rerun with a larger review budget
- `/ai-review explain <file>:<line>`: explain a specific changed area
- `/ai-review ci`: summarize failed checks for the PR head commit
- `/ai-review help`: show command help

The bot also replies inside review threads when a comment mentions a configured bot name or includes `/ai-review`. Set `bot_mentions` to the GitHub username of your review bot account.

## Local development

```bash
npm install
npm run typecheck
npm test
```

For a real PR run, GitHub Actions provides `GITHUB_EVENT_PATH` and `GITHUB_REPOSITORY`.
