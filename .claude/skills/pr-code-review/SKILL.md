---
name: pr-code-review
description: Review a GitHub PR in the crispin-lab org and post inline + summary review comments using a dedicated bot GitHub account, or (with --reply) respond to replies on prior bot review threads and auto-resolve confirmed-fixed conversations. Loads the target repo's .claude/ conventions, dedups against prior bot comments, and posts as a single GitHub Review. Use when the user asks to review a PR by URL or owner/repo#number form, e.g. "/pr-code-review crispin-lab/crispin-lab-frontend#42" or "/pr-code-review https://github.com/crispin-lab/crispin-lab-backend/pull/17 --reply".
---

# pr-code-review

Two modes, picked by flag:

**Review mode** (default) — drive an end-to-end PR review:

1. Parse the PR target + flags from args.
2. Fetch PR metadata, diff, body, and linked issues using the user's own `gh` auth.
3. Load the target repo's `.claude/` conventions at the PR head SHA (local clone fallback).
4. Guard against oversized PRs.
5. Dedup against prior bot review comments via fingerprints.
6. Have Claude review the diff against the loaded conventions.
7. Post a **single GitHub Review** with inline comments + summary, using the **bot account's** `gh` profile.

**Reply mode** (`--reply`) — respond to replies on prior bot review threads:

1. Same parse / verify / fetch as steps 1–3.
2. Fetch all open review threads via GraphQL.
3. Filter to threads the bot started where the most recent comment is NOT from the bot (loop-safe).
4. For each, classify intent (fixed / disagreement / clarification / question) and check whether the file at HEAD actually addresses the original finding.
5. Post a reply per thread. If the fix is confirmed, also resolve the thread and leave an acknowledgement comment.

The bot account is isolated via `GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config`. This never touches the user's primary `gh` login.

## Args

`/pr-code-review <target> [flags]`

`<target>`:
- `owner/repo#NUMBER` — e.g. `crispin-lab/crispin-lab-frontend#42`
- A GitHub PR URL — e.g. `https://github.com/crispin-lab/crispin-lab-backend/pull/42`

Flags:
- `--dry-run` — do everything except posting. In review mode, writes the planned review to `/tmp/pcr-<repo>-<num>.md`. In reply mode, writes planned replies and resolutions to `/tmp/pcr-replies-<repo>-<num>.md`.
- `--focus <category>[,<category>...]` — review mode only. Narrow the review to one or more of: `correctness`, `security`, `conventions`, `reuse`, `perf`, `tests`. Skips findings outside the focus.
- `--force` — review mode only. Bypass both the big-PR guard (step 4) and the rate-limit guard (step 4.5).
- `--with-codex` — review mode only. Run a codex CLI critic pass between the Claude review and posting. See step 7.5.
- `--reply` — switch to **reply mode**: skip diff review and instead process replies on prior bot review threads. See "Reply mode pipeline" below. Rate-limit guard does NOT apply.

If the target is missing or unparseable, ask the user. Do not guess.

If `--reply` is combined with review-only flags (`--focus`, `--force`, `--with-codex`), warn the user that those flags are ignored in reply mode but continue.

## Steps

Steps 1–3 are shared between modes. After step 3, branch:

- Default (no `--reply`): continue with steps 4 → 10 (review mode).
- `--reply`: skip steps 4–10 entirely and jump to the **"Reply mode pipeline"** section below.

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

## Reply mode pipeline

Entered only when `--reply` is set. Steps 1–3 (parse / verify / fetch PR metadata) have already run. Conventions loading (step 5) still applies — load `.claude/CLAUDE.md` + `@rules/*.md` at the PR head SHA, same as review mode, since responses must respect them. Skip the big-PR guard, rate-limit guard, fingerprint dedup, diff review, codex critic, and the GitHub Review POST.

### R1. Post start signal (👀)

Same as step 4.5's reaction logic, but no rate-limit check:

```bash
REACTION_ID=$(GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config \
  gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/issues/<num>/reactions \
  -f content=eyes \
  --jq .id)
```

Skip if `--dry-run`.

### R2. Fetch all review threads (GraphQL)

Use the user's primary `gh` auth for the read:

```bash
gh api graphql -F owner=<owner> -F repo=<repo> -F num=<num> -f query='
  query($owner:String!, $repo:String!, $num:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$num) {
        reviewThreads(first:100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            path
            line
            originalLine
            comments(first:100) {
              nodes {
                databaseId
                author { login }
                body
                createdAt
                replyTo { databaseId }
              }
            }
          }
        }
      }
    }
  }'
```

If `hasNextPage`, paginate with `after: endCursor`. (Cap at 5 pages — surface a warning if exceeded.)

### R3. Filter to threads needing a response

Iterate `reviewThreads.nodes`. For each thread, keep it only if ALL hold:

- `isResolved == false`
- `comments.nodes[0].author.login == <BOT_LOGIN>` (the bot started the thread)
- `comments.nodes[-1].author.login != <BOT_LOGIN>` (someone else has the last word — awaiting our response)

The third check is the **loop guard**: once the bot replies, the bot becomes the last commenter, so the thread won't re-trigger until the human replies again.

If zero threads remain, post a no-op summary message (or just report "no threads need a response") and stop.

### R4. Build per-thread context and classify intent

For each surviving thread, gather:

- The original bot comment (`comments.nodes[0].body` — strip `<!-- pcr:... -->` markers when showing to the model)
- The full reply history in order (each with author and body)
- The file at HEAD, fetched once per unique path:
  ```bash
  gh api "repos/<owner>/<repo>/contents/<path>?ref=<headRefOid>" --jq '.content' | base64 -d
  ```
  If the file is gone (404 = deleted at HEAD), record that fact — it usually means the user removed the offending code.
- The thread's `path` + `line` + `originalLine` so the model can locate the relevant code region.
- The loaded `.claude/` conventions.

Call Claude per thread (or in a small batch — at most 5 threads per batch to keep prompts focused). Force this JSON schema:

```json
{
  "threadId": "string (GraphQL node id, passed through unchanged)",
  "intent": "fixed | disagreement | clarification_request | agreement | question",
  "fix_confirmed": "boolean",
  "reply_body": "string (1-3 sentences; match the language of the conversation — Korean if the replies are Korean)",
  "should_resolve": "boolean"
}
```

Rules the model must follow:

- `fix_confirmed = true` ONLY if **both** hold:
  - The user's reply claims or implies the issue has been addressed (intent ∈ {`fixed`, `agreement`} with a fix statement).
  - The current file content at HEAD (or its deletion) actually addresses the original finding at the relevant line region. Don't take the user's word alone.
- `should_resolve = fix_confirmed`. Never resolve on disagreement or clarification.
- `reply_body` content by intent:
  - `intent=fixed && fix_confirmed=true` → short acknowledgement, e.g. "수정 확인했습니다. 반영해 주셔서 감사합니다."
  - `intent=fixed && fix_confirmed=false` → ask politely where the fix went in, e.g. "해당 위치엔 아직 변경이 안 보이는데, 혹시 다른 곳에서 처리하셨나요? 확인을 위해 알려 주세요."
  - `intent=disagreement` → weigh the user's reasoning against the rule/diff. If the user cites a valid reason (rule we missed, context we lacked), retract gracefully: "지적 감사합니다. 룰 X 기준으로 보면 현 코드가 맞네요. 의견 철회하겠습니다." If still concerned, restate the original concern in 1 sentence with the rule citation.
  - `intent=clarification_request` / `question` → provide the explanation, again citing the relevant rule file/section when applicable.
  - `intent=agreement` (without fix) → brief acknowledgement, no resolve.
- Append `<!-- pcr:reply -->` to every `reply_body` (helps future runs identify bot replies even if the bot account is later renamed).

Fail-safe: if the model returns an unparseable response or omits `threadId`, **skip that thread** with a warning logged for the user — do NOT guess.

### R5. Confirm with the user (always, including `--dry-run`)

Before posting, print a digest:

- Target: `owner/repo#NUMBER` @ `<headRefOid[:7]>`
- Bot login: `<BOT_LOGIN>`
- Threads found: `<total>` / responding to: `<N>` / will resolve: `<M>` / skipped: `<K>`
- Per-thread one-liners: `path:line — intent=<…> resolve=<true|false>`
- First 3 reply bodies in full (then "... and N more")

If `--dry-run`: write the full plan (all reply bodies + resolve flags) to `/tmp/pcr-replies-<repo>-<num>.md`, print the path, stop.

Otherwise, ask the user to confirm before any write.

### R6. Post replies and resolve threads

For each thread, in order:

**Post the reply** (REST, bot's gh, threaded under the original comment):

```bash
GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config \
  gh api --method POST \
  /repos/<owner>/<repo>/pulls/<num>/comments \
  -f body="<reply_body>" \
  -F in_reply_to=<root_comment_databaseId>
```

(`root_comment_databaseId` = `comments.nodes[0].databaseId` from R2 — the REST numeric ID of the bot's original comment that started the thread.)

**If `should_resolve == true`, resolve the thread** (GraphQL mutation, bot's gh):

```bash
GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config \
  gh api graphql -F id="<thread.id>" -f query='
    mutation($id:ID!) {
      resolveReviewThread(input:{threadId:$id}) {
        thread { id isResolved }
      }
    }'
```

(`thread.id` is the GraphQL node ID from R2, NOT the comment's databaseId.)

Order matters: post the reply FIRST, then resolve. If resolve runs before the reply, the acknowledgement lands on a closed thread and is easier to miss.

If a reply POST fails, log it and move on — never resolve a thread whose acknowledgement reply didn't post.

### R7. Report + reaction swap

- If `REACTION_ID` was captured in R1, swap 👀 → 🎉 the same way as step 10.
- Print a summary: `<N>` replies posted, `<M>` threads resolved, `<K>` threads failed (with reasons), `<S>` threads skipped (no response needed).
- Do NOT update the rate-limit state file — reply mode doesn't participate in that guard.

## Notes

- **Never** mutate the user's primary `gh` auth, switch accounts, or run `gh auth login` without `GH_CONFIG_DIR` set.
- The bot's `bot-gh-config/` directory is 700 and must not be backed up to shared storage.
- Local clone path convention: `~/documents/personal/git/<repo-name>` (the GitHub repo name verbatim, e.g. `crispin-lab-backend`).
- Bot PAT needs `Contents: Read` on each target repo to fetch `.claude/` files via the API path.
- `--with-codex` requires the `codex` CLI on `PATH` and a valid codex login (`codex login`) or `OPENAI_API_KEY` in env, depending on how codex is configured locally. The critic pass uses `--sandbox read-only` — codex cannot mutate the working tree.
- Rate-limit state is per-PR-per-head-SHA, stored locally in `~/.claude/skills/pr-code-review/state/`. The guard is intentionally simple: a force-push (new head SHA) always bypasses it, and `--force` overrides everything. The bot PAT needs `Issues: write` (already in SETUP.md) to post the 👀/🎉 reactions via the `/issues/{num}/reactions` endpoint.
- **Reply mode** uses GraphQL (`reviewThreads`, `resolveReviewThread`) in addition to REST. The bot PAT scopes already cover this — no extra scope needed beyond Pull requests: R/W. The loop guard relies on "last commenter is not the bot", so renaming the bot account mid-flight will temporarily break it until the bot replies again (the `<!-- pcr:reply -->` marker is a secondary safety net but the primary check is author login).
