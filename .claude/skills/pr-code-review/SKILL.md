---
name: pr-code-review
description: Review a GitHub PR in the crispin-lab org and post inline + summary review comments using a dedicated bot GitHub account. Loads the target repo's .claude/ conventions, dedups against prior bot comments, and posts as a single GitHub Review. Use when the user asks to review a PR by URL or owner/repo#number form, e.g. "/pr-code-review crispin-lab/crispin-lab-frontend#42" or "/pr-code-review https://github.com/crispin-lab/crispin-lab-backend/pull/17".
---

# pr-code-review

Drive an end-to-end PR review for a repository in the `crispin-lab` GitHub organization:

1. Parse the PR target + flags from args.
2. Fetch PR metadata, diff, body, and linked issues using the user's own `gh` auth.
3. Load the target repo's `.claude/` conventions at the PR head SHA (local clone fallback).
4. Guard against oversized PRs.
5. Dedup against prior bot review comments via fingerprints.
6. Have Claude review the diff against the loaded conventions.
7. Post a **single GitHub Review** with inline comments + summary, using the **bot account's** `gh` profile.

The bot account is isolated via `GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config`. This never touches the user's primary `gh` login.

## Args

`/pr-code-review <target> [flags]`

`<target>`:
- `owner/repo#NUMBER` — e.g. `crispin-lab/crispin-lab-frontend#42`
- A GitHub PR URL — e.g. `https://github.com/crispin-lab/crispin-lab-backend/pull/42`

Flags:
- `--dry-run` — do everything except posting. Writes the planned review to `/tmp/pcr-<repo>-<num>.md` and reports the path.
- `--focus <category>[,<category>...]` — narrow the review to one or more of: `correctness`, `security`, `conventions`, `reuse`, `perf`, `tests`. Skips findings outside the focus.
- `--force` — bypass both the big-PR guard (step 4) and the rate-limit guard (step 4.5).
- `--with-codex` — run a codex CLI critic pass between the Claude review and posting. Each finding is judged by codex against the diff + conventions; rejections are dropped. See step 7.5.

If the target is missing or unparseable, ask the user. Do not guess.

## Steps

### 1. Parse target + flags

Extract `owner`, `repo`, `pr_number` from the input. Reject anything where `owner != "crispin-lab"` — this skill is org-scoped on purpose.

Parse flags. Unknown flags → fail with a clear message.

### 2. Verify bot setup

```bash
GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config gh auth status 2>&1
```

If "not logged in", stop and point the user to `~/.claude/skills/pr-code-review/SETUP.md`. Do not proceed.

Resolve the bot login (used in step 5 and step 8):

```bash
BOT_LOGIN=$(GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config gh api user --jq .login)
```

### 3. Fetch PR context (user's own gh)

Use the user's primary `gh` auth (no `GH_CONFIG_DIR`) for all reads.

```bash
gh pr view <num> --repo <owner>/<repo> --json number,title,body,headRefOid,baseRefName,headRefName,author,isDraft,state,additions,deletions,changedFiles,files
gh pr diff <num> --repo <owner>/<repo> --patch
```

If the PR is `closed`/`merged`/`draft`, ask the user whether to continue.

**Linked issues**: scan PR body for `(?:Fixes|Closes|Resolves|Refs)\s+#(\d+)` (case-insensitive). For each issue number:

```bash
gh issue view <n> --repo <owner>/<repo> --json title,body,labels
```

Cap at 5 linked issues to avoid context bloat.

### 4. Big PR guard

Compute `total_changes = additions + deletions`.

- If `changedFiles > 50` or `total_changes > 2000`: warn the user with the numbers, list the largest files, and ask whether to continue, skip, or bail. Skip = review only the top 20 files by churn.
- `--force` skips this guard.

### 4.5. Rate-limit guard + start signal

**Rate-limit guard**

State file location: `~/.claude/skills/pr-code-review/state/<owner>__<repo>__<num>.json`

If the file exists, parse `last_run_at` (ISO 8601) and `last_head_sha`. Refuse the run if **all** of:

- `last_head_sha == <current headRefOid>` (same commit being re-reviewed)
- `now - last_run_at < 10 minutes`
- `--force` is not set

On refusal, print: target, last run timestamp, elapsed minutes, and "use `--force` to override or wait <N> minutes". Then stop.

Different head SHA = pass (force-push or new commits — always re-review). Older than 10 min = pass.

**Start signal (👀 reaction)**

If not `--dry-run`, post a `eyes` reaction on the PR using the bot's gh, capturing the reaction ID:

```bash
REACTION_ID=$(GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config \
  gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/issues/<num>/reactions \
  -f content=eyes \
  --jq .id)
```

Hold `REACTION_ID` for step 10. If the API call fails (e.g. PR locked), log a warning and continue — the review still proceeds.

### 5. Load project conventions

Two sources, in this order:

**A. Local clone (preferred when matching head)**

Check if `~/documents/personal/git/<repo>` exists (note: `<repo>` is the GitHub repo name, e.g. `crispin-lab-backend`, not `<owner>/<repo>`). If yes, run:

```bash
cd ~/documents/personal/git/<repo> && git fetch origin && git show <headRefOid>:.claude/CLAUDE.md 2>/dev/null
```

If `git show` at the head SHA works, read `.claude/CLAUDE.md` + each `@rules/<file>.md` import the same way (`git show <headRefOid>:.claude/rules/<file>.md`). This guarantees the conventions match the PR head, not the local checkout.

**B. gh API fallback**

If no local clone (or `git show` fails), fetch via API at the head SHA:

```bash
gh api "repos/<owner>/<repo>/contents/.claude/CLAUDE.md?ref=<headRefOid>" --jq '.content' | base64 -d
```

Parse `@rules/<file>.md` references from `CLAUDE.md`, then fetch each:

```bash
gh api "repos/<owner>/<repo>/contents/.claude/rules/<file>.md?ref=<headRefOid>" --jq '.content' | base64 -d
```

If `.claude/CLAUDE.md` doesn't exist (404), continue without conventions and note it in the summary.

Combine all loaded rule text and pass it to the review step as **the authoritative convention reference for this PR**. The review must cite the specific rule when flagging a convention violation (e.g. "violates `conventions.md` §네이밍 — `Dto` suffix").

### 6. Dedup against prior bot comments

List the bot's existing review comments on this PR:

```bash
gh api "repos/<owner>/<repo>/pulls/<num>/comments" --paginate --jq '.[] | select(.user.login == "'$BOT_LOGIN'") | .body'
gh api "repos/<owner>/<repo>/pulls/<num>/reviews" --paginate --jq '.[] | select(.user.login == "'$BOT_LOGIN'") | .body'
```

Extract fingerprints — they're hidden HTML comments in body bodies of the form `<!-- pcr:HASH -->`. Build a set of seen hashes.

Each new finding computes its fingerprint as:

```
hash = sha1(lower(path) + ":" + line + ":" + normalized_first_80_chars_of_body)[:12]
```

Where `normalized_first_80_chars_of_body` lowercases and collapses whitespace. Skip findings whose hash is already in the seen set. Append `\n\n<!-- pcr:HASH -->` to every new comment body and to the summary body (use the summary's own hash based on `"summary:<num>:<headRefOid>"`).

This makes reruns idempotent across force-pushes.

### 7. Review the diff

For each file in the diff (after big-PR-guard filtering):

- Identify concrete issues on **added lines only** (`+` lines, excluding `+++` headers).
- Categorize: `correctness`, `security`, `conventions`, `reuse`, `perf`, `tests`. Skip style/format unless `--focus conventions` is on.
- If `--focus` is set, drop findings outside the focused categories.
- For each finding, capture: `path`, `line` (new-file line number), `side: "RIGHT"`, `body` (1–3 sentences, actionable, quote the offending snippet). Cite the matching rule file/section if the finding came from a `.claude/rules/*.md` violation.
- Compute fingerprint, skip if seen.

Write a 3–6 sentence summary covering: scope, top risks, the 1–2 main themes, plus a note if conventions were/weren't loaded and how many prior findings were deduped.

Quality guardrails:
- Default to **fewer, higher-confidence** findings. If <70% sure it's a real issue, leave it out (unless `--focus` says otherwise).
- Skip generated files, lockfiles, snapshots, build outputs.
- Don't comment on style/naming unless a rule file explicitly says so.

If zero new findings remain after dedup + focus, post the summary review with `event: "COMMENT"` and an empty `comments` array, saying so explicitly (e.g. "No new findings — N previous findings still apply.").

### 7.5. Codex critic pass (only when `--with-codex`)

If the flag is **not** set, skip this step entirely.

When set, hand every surviving finding to `codex exec` and have it judge whether the finding is a real issue against the diff + loaded conventions. Drop findings codex rejects; keep the rest.

Preflight:

```bash
command -v codex >/dev/null || { echo "codex CLI not found — install it or drop --with-codex"; exit 1; }
```

Build a single prompt payload (one call, batch all findings — cheaper and gives codex cross-finding context):

```jsonc
// /tmp/pcr-critic-<num>-input.json
{
  "task": "critic",
  "instructions": "You are a code-review critic. For EACH finding, decide if it is a real, actionable issue given the diff and the project's conventions. Be conservative — if a finding is speculative, off-topic for the diff, or contradicted by the conventions/PR context, set keep=false. Output JSON ONLY in the exact schema below.",
  "schema": {
    "verdicts": [
      { "fingerprint": "string", "keep": "boolean", "reason": "string (<=200 chars)" }
    ]
  },
  "pr": { "owner": "...", "repo": "...", "number": 42, "title": "...", "body": "..." },
  "conventions": "<combined .claude rule text>",
  "diff": "<unified diff>",
  "findings": [
    { "fingerprint": "abc123def456", "path": "src/foo.ts", "line": 42, "category": "correctness", "body": "..." }
  ]
}
```

Invoke codex non-interactively, read-only sandbox, JSON-only output:

```bash
codex exec \
  --sandbox read-only \
  --skip-git-repo-check \
  "$(cat <<'PROMPT'
You are a code-review critic. Read the JSON on stdin. For each finding, decide if it is a real, actionable issue given the diff and conventions. Be conservative: reject speculative findings, findings outside the diff scope, and findings contradicted by the conventions or PR context. Output ONLY a JSON object matching {"verdicts":[{"fingerprint":string,"keep":boolean,"reason":string}]}. No prose, no markdown fences.
PROMPT
)" < /tmp/pcr-critic-<num>-input.json > /tmp/pcr-critic-<num>-output.json
```

(If `--skip-git-repo-check` is unsupported on the installed codex version, drop it — the call still works from any cwd.)

Parse the verdicts. Apply this filter:

- `keep: true` → keep the finding.
- `keep: false` → drop it, log the reason for the user-facing summary preview.
- Fingerprint missing from verdicts, or output unparseable → **keep the finding** (fail-open — never lose findings due to critic errors). Note this in the summary.

In the summary body, append a line: `Codex critic: kept N / dropped M (model: <codex model>, prompt cached: yes/no)`. If parsing failed, say `Codex critic: parse failed, all findings kept`.

### 8. Show the user the review before posting

Print:
- Target: `owner/repo#NUMBER` @ `<headRefOid[:7]>`
- Posting as: `<BOT_LOGIN>`
- Conventions loaded: `<N rule files>` (source: local clone | gh API | none)
- Linked issues: list
- Findings: count by category
- Deduped: count of skipped (already posted) findings
- Codex critic: kept/dropped counts (only if `--with-codex` ran)
- Summary body preview
- Inline comments preview (first 3, then "... and N more")

Ask for confirmation. If `--dry-run`, skip the confirmation, write the full review markdown to `/tmp/pcr-<repo>-<num>.md`, print the path, stop.

### 9. Post the review (bot's gh)

Build the payload for `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`:

```json
{
  "commit_id": "<headRefOid>",
  "body": "<summary including pcr:HASH>",
  "event": "COMMENT",
  "comments": [
    { "path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "... <!-- pcr:HASH -->" }
  ]
}
```

`event` is always `COMMENT` — never `APPROVE`/`REQUEST_CHANGES`. Write to a temp file and post:

```bash
GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config \
  gh api --method POST \
  /repos/<owner>/<repo>/pulls/<num>/reviews \
  --input /tmp/pcr-review-<num>.json
```

If GitHub rejects an inline comment (line not in diff hunks), retry once with that comment moved into the summary body as `<file>:<line> — <comment>`. Don't drop findings silently.

### 10. Report + finalize state

**Update state file** (step 4.5's path):

```bash
STATE_FILE=~/.claude/skills/pr-code-review/state/<owner>__<repo>__<num>.json
mkdir -p "$(dirname "$STATE_FILE")"
jq -n \
  --arg sha "<headRefOid>" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg rid "<review_id from POST response>" \
  '{last_head_sha: $sha, last_run_at: $at, last_review_id: $rid}' \
  > "$STATE_FILE"
```

**Swap 👀 → 🎉 on success** (only if `REACTION_ID` was captured in step 4.5):

```bash
GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config \
  gh api --method DELETE \
  /repos/<owner>/<repo>/issues/<num>/reactions/$REACTION_ID

GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config \
  gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/issues/<num>/reactions \
  -f content=hooray
```

If the review POST failed, leave 👀 in place so the unfinished state is visible.

**Report**

Print the review URL (`html_url` from the POST response), the count of comments posted, the count deduped from prior runs, and the codex critic kept/dropped if applicable.

## Notes

- **Never** mutate the user's primary `gh` auth, switch accounts, or run `gh auth login` without `GH_CONFIG_DIR` set.
- The bot's `bot-gh-config/` directory is 700 and must not be backed up to shared storage.
- Local clone path convention: `~/documents/personal/git/<repo-name>` (the GitHub repo name verbatim, e.g. `crispin-lab-backend`).
- Bot PAT needs `Contents: Read` on each target repo to fetch `.claude/` files via the API path.
- `--with-codex` requires the `codex` CLI on `PATH` and a valid codex login (`codex login`) or `OPENAI_API_KEY` in env, depending on how codex is configured locally. The critic pass uses `--sandbox read-only` — codex cannot mutate the working tree.
- Rate-limit state is per-PR-per-head-SHA, stored locally in `~/.claude/skills/pr-code-review/state/`. The guard is intentionally simple: a force-push (new head SHA) always bypasses it, and `--force` overrides everything. The bot PAT needs `Issues: write` (already in SETUP.md) to post the 👀/🎉 reactions via the `/issues/{num}/reactions` endpoint.
