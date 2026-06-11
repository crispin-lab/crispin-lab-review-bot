---
name: pr-code-review
description: Review a GitHub PR in the crispin-lab org and post inline + summary review comments using a dedicated bot GitHub account, or (with --reply) respond to replies on prior bot review threads and auto-resolve confirmed-fixed conversations. Loads the target repo's .claude/ conventions, dedups against prior bot comments, and posts as a single GitHub Review. Use when the user asks to review a PR by URL or owner/repo#number form, e.g. "/pr-code-review crispin-lab/crispin-lab-frontend#42" or "/pr-code-review https://github.com/crispin-lab/crispin-lab-backend/pull/17 --reply".
---

# pr-code-review

Two modes:
- **Review mode** (default) — review the diff and post a single GitHub Review with inline comments + summary as the bot.
- **Reply mode** (`--reply`) — respond to replies on prior bot review threads; auto-resolve threads when the fix is confirmed at HEAD.

**Bot account isolation**: every bot-side `gh` call must use `GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config`. Below this is shortened to `<BOT_GH>` — expand it in real commands. **Never** mutate the user's primary `gh` auth.

## Help short-circuit (do this FIRST)

If the user's invocation contains `--help` or `-h` ANYWHERE in the args (with or without a target — e.g. `/pr-code-review --help`, `/pr-code-review crispin-lab/foo#1 --help`, `/pr-code-review -h`):

1. Read `/Users/crispin/.claude/skills/pr-code-review/HELP.ko.md` with the Read tool.
2. Output its **full contents verbatim** to the user as your reply. Do NOT summarize, paraphrase, translate, or wrap with extra text.
3. Stop. Do NOT parse the target, do NOT verify bot setup, do NOT call any other tool.

This precedes every other step in this skill — including target parsing and unknown-flag rejection. A missing target is fine when `--help` is present.

## Args

`/pr-code-review <target> [flags]`

`<target>`: `owner/repo#NUMBER` or PR URL. `owner` MUST be `crispin-lab`.

Flags:
- `--dry-run` — both modes. No posting; write plan to `/tmp/pcr-<repo>-<num>.md` (review) or `/tmp/pcr-replies-<repo>-<num>.md` (reply).
- `--yes`, `-y` — both modes. Skip **ALL** routine confirmation prompts, including: step 3 closed/merged/draft warning, step 8 review preview, R5 reply digest, and any "should I proceed / post / continue?" self-check you might be tempted to ask before a write (review POST, reply POST, thread resolve, reaction post/delete). With `--yes`, the only allowed stops are hard guards: big-PR guard (step 4), rate-limit guard (step 4.5), missing/invalid target, bot-not-logged-in, GitHub API errors. Use `--force` to bypass the big-PR + rate-limit guards. `--dry-run` overrides `--yes` (dry-run still writes its plan file and stops at step 8 / R5).
- `--focus <cat>[,...]` — review only. Limit findings to: `correctness`, `security`, `conventions`, `reuse`, `perf`, `tests`.
- `--force` — review only. Bypass big-PR + rate-limit guards.
- `--with-codex` — review only. Codex CLI critic pass between review and post.
- `--auto-reply` — review only. After step 10 (review posted), automatically chain into Reply mode (R1) against the same PR so existing user replies on prior bot threads are processed in the same run. Combine with `--yes` for fully non-interactive review→reply.
- `--reply` — switch to reply mode (rate-limit guard does not apply).
- `--help`, `-h` — print help and stop.

Unknown flag → fail clearly. Missing/unparseable target → ask the user. `--reply` + review-only flags → warn (ignored) but continue.

## Shared pipeline (steps 0–3)

After step 3: `--reply` → jump to **Reply mode**, else continue with **Review mode**.

### 0. Help short-circuit

Handled at the top of this document under "Help short-circuit (do this FIRST)". If `--help` / `-h` is in the args, you should never reach this step.

### 1. Parse target + flags

Extract `owner`, `repo`, `pr_number`. Reject `owner != "crispin-lab"`. Reject unknown flags.

### 2. Verify bot setup

```bash
<BOT_GH> gh auth status 2>&1
```

If not logged in, point user to `~/.claude/skills/pr-code-review/SETUP.md` and stop.

```bash
BOT_LOGIN=$(<BOT_GH> gh api user --jq .login)
```

### 3. Fetch PR context (user's own gh — no `GH_CONFIG_DIR`)

```bash
gh pr view <num> --repo <owner>/<repo> --json number,title,body,headRefOid,baseRefName,headRefName,author,isDraft,state,additions,deletions,changedFiles,files
gh pr diff <num> --repo <owner>/<repo> --patch
```

If `closed`/`merged`/`draft`, ask whether to continue — UNLESS `--yes` is set (then warn once in the report and continue).

**Linked issues**: scan PR body for `(?:Fixes|Closes|Resolves|Refs)\s+#(\d+)` (case-insensitive). Cap at 5:

```bash
gh issue view <n> --repo <owner>/<repo> --json title,body,labels
```

## Review mode (steps 4–10)

### 4. Big-PR guard

`total_changes = additions + deletions`. If `changedFiles > 50` OR `total_changes > 2000`: warn with numbers + largest files, ask continue / skip / bail. Skip = review only top 20 files by churn. `--force` skips this guard.

### 4.5. Rate-limit guard + start signal

State file: `~/.claude/skills/pr-code-review/state/<owner>__<repo>__<num>.json` with `{last_run_at, last_head_sha, last_review_id}`.

**Refuse** if **all** hold: `last_head_sha == <current headRefOid>` AND `now - last_run_at < 10 min` AND no `--force`. On refusal print target / last run / elapsed / "use `--force` to override or wait <N> minutes". Stop. Different head SHA = always re-review.

**Post 👀 immediately**, BEFORE step 5 (conventions load) and step 7 (diff review). This is the very next action after the rate-limit guard passes — no confirmation prompt, no LLM call, no other tool call first. Posts on every run including `--dry-run`. Capture the reaction id (held for step 10). The signal must reach GitHub **before** the slow diff-review work starts, so the user sees "bot is looking at this PR" while waiting. Posting 👀 only right before step 9 POST would defeat the signal — at that point the review is already written.

**Never prompt the user before posting 👀**. Reactions are status signals, not "writes that need confirmation" — they post unconditionally (even without `--yes`).

```bash
REACTION_ID=$(<BOT_GH> gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/issues/<num>/reactions \
  -f content=eyes --jq .id)
```

On 👀 failure (e.g. PR locked): warn and continue — review still proceeds.

In the dry-run → post follow-up flow (see Notes), do NOT re-post 👀 — the prior dry-run already did, and 👀→🎉 swap in step 10 will reuse that reaction id.

### 5. Load conventions at the head SHA

**A. Local clone preferred** at `~/documents/personal/git/<repo>` (GitHub repo name verbatim, e.g. `crispin-lab-backend`):

```bash
cd ~/documents/personal/git/<repo> && git fetch origin && git show <headRefOid>:.claude/CLAUDE.md 2>/dev/null
```

Parse `@rules/<file>.md` imports from `CLAUDE.md` and fetch each via `git show <headRefOid>:.claude/rules/<file>.md`. This guarantees conventions match the PR head, not the local checkout.

**B. gh API fallback** (no clone or `git show` fails):

```bash
gh api "repos/<owner>/<repo>/contents/.claude/CLAUDE.md?ref=<headRefOid>" --jq '.content' | base64 -d
gh api "repos/<owner>/<repo>/contents/.claude/rules/<file>.md?ref=<headRefOid>" --jq '.content' | base64 -d
```

If 404, continue without conventions and note in the summary. Conventions are the **authoritative reference** — every convention finding must cite the rule file/section (e.g. "violates `conventions.md` §네이밍 — `Dto` suffix").

### 6. Dedup against prior bot comments

```bash
gh api "repos/<owner>/<repo>/pulls/<num>/comments" --paginate --jq '.[] | select(.user.login == "'$BOT_LOGIN'") | .body'
gh api "repos/<owner>/<repo>/pulls/<num>/reviews"  --paginate --jq '.[] | select(.user.login == "'$BOT_LOGIN'") | .body'
```

Fingerprints are hidden HTML markers `<!-- pcr:HASH -->`. Per finding:

```
hash = sha1(lower(path) + ":" + line + ":" + normalized_first_80_chars_of_body)[:12]
```

(`normalized` = lowercased + whitespace collapsed.) Skip findings whose hash is seen. Append `<!-- pcr:HASH -->` to every new comment body. Summary uses its own hash from `"summary:<num>:<headRefOid>"`. Makes reruns idempotent across force-pushes.

### 7. Review the diff

Per file (after big-PR-guard filtering):
- Issues on **added lines only** (`+`, excluding `+++` headers).
- Categorize as `correctness`, `security`, `conventions`, `reuse`, `perf`, `tests`. Skip style/format unless `--focus conventions`.
- Apply `--focus` filter.
- Each finding: `path`, `line` (new-file line number), `side: "RIGHT"`, `body` (1–3 sentences, actionable, quote the offending snippet). Cite the rule file/section on convention findings.
- Compute fingerprint; skip if seen.

Summary uses these **EXACT** section headers, in this order. Headers are fixed strings — never rename, translate, or reorder. Body is free-form Korean prose (or English if the PR conversation is English). Omit a section entirely (header + body) only when it would be empty; never leave a header with an empty body.

```
## Scope
<1 line: N files, +X/-Y. What the PR does.>

## Risks
- <bullet per finding-level risk; one line each. Omit section if zero findings.>

## Themes
- <1–2 bullets on cross-cutting patterns the reviewer noticed (good or bad).>

## Conventions
<one line: N rule files loaded from {local clone | gh API} @ <sha[:7]> | none loaded (404).>

## Dedup
<one line: N prior bot findings still apply, M new findings this run. Or: no prior findings.>
```

If `--with-codex` ran, append one line below `## Dedup`: `Codex critic: kept N / dropped M.` (or `parse failed, all findings kept`). Do NOT add a new section header for it.

Guardrails:
- **Fewer, higher-confidence** by default. <70% sure → drop (unless `--focus` says otherwise).
- Skip generated files, lockfiles, snapshots, build outputs.
- No style/naming unless a rule file explicitly says so.

If zero new findings, post summary review with `event: "COMMENT"`, empty `comments`, body saying so (e.g. "No new findings — N previous findings still apply.").

### 7.5. Codex critic pass (only `--with-codex`)

If not set, skip entirely.

Preflight: `command -v codex >/dev/null || { echo "codex CLI not found — install it or drop --with-codex"; exit 1; }`

One batched call. Build `/tmp/pcr-critic-<num>-input.json`:

```jsonc
{
  "task": "critic",
  "schema": { "verdicts": [{ "fingerprint": "string", "keep": "boolean", "reason": "string (<=200 chars)" }] },
  "pr": { "owner": "...", "repo": "...", "number": 42, "title": "...", "body": "..." },
  "conventions": "<combined .claude rule text>",
  "diff": "<unified diff>",
  "findings": [{ "fingerprint": "...", "path": "...", "line": 42, "category": "correctness", "body": "..." }]
}
```

Invoke (read-only sandbox, JSON-only output):

```bash
codex exec --sandbox read-only --skip-git-repo-check "$(cat <<'PROMPT'
You are a code-review critic. Read JSON on stdin. For each finding, decide if it is a real, actionable issue given the diff and conventions. Be conservative: reject speculative findings, findings outside the diff scope, and findings contradicted by the conventions or PR context. Output ONLY {"verdicts":[{"fingerprint":string,"keep":boolean,"reason":string}]}. No prose, no fences.
PROMPT
)" < /tmp/pcr-critic-<num>-input.json > /tmp/pcr-critic-<num>-output.json
```

(Drop `--skip-git-repo-check` if unsupported on the installed codex.)

Apply verdicts: `keep:true` → keep; `keep:false` → drop and log reason; missing fingerprint or unparseable output → **keep** (fail-open, never lose findings to critic errors). The codex line is appended to the summary under `## Dedup` per step 7's template.

### 8. Confirm before posting

Print:
- Target: `owner/repo#NUMBER` @ `<headRefOid[:7]>`
- Posting as: `<BOT_LOGIN>`
- Conventions: `<N>` rule files (source: local clone | gh API | none)
- Linked issues
- Findings by category, dedup count, codex critic kept/dropped (if ran)
- Summary preview + first 3 inline comments (then "... and N more")

Ask for confirmation — unless `--yes` is set (then proceed directly to step 9). `--dry-run` → write full markdown to `/tmp/pcr-<repo>-<num>.md`, print path, stop (overrides `--yes`). The 👀 from step 4.5 stays on the PR; if the user later says "post" in the same conversation, see the dry-run → post Notes for the shortcut.

### 9. Post the review (bot's gh)

`event` is **always** `COMMENT` — never `APPROVE`/`REQUEST_CHANGES`.

Payload for `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`:

```json
{
  "commit_id": "<headRefOid>",
  "body": "<summary including pcr:HASH>",
  "event": "COMMENT",
  "comments": [{ "path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "... <!-- pcr:HASH -->" }]
}
```

**Newline guard**: NEVER inline-escape newlines as `\n` inside a body string and pass it through `jq --arg` / `-f body=...` — `--arg` treats the value as literal, so `\n` becomes `\\n` in the JSON file and GitHub stores the two characters `\` + `n`, rendering the summary as one giant line (observed on PR #53). Always write the body to a file with REAL LFs (heredoc, not `printf "...\n..."`) and pull it in with `jq --rawfile`. Same rule applies to any multi-line inline comment body.

```bash
# Summary body in its OWN file with real newlines.
cat > /tmp/pcr-summary-<num>.md <<'EOF'
<summary text with actual line breaks>

<!-- pcr:HASH -->
EOF

# Compose payload with --rawfile so LFs survive into the JSON string.
jq -n \
  --arg commit_id "<headRefOid>" \
  --rawfile body /tmp/pcr-summary-<num>.md \
  --argjson comments "$INLINE_COMMENTS_JSON" \
  '{commit_id:$commit_id, body:$body, event:"COMMENT", comments:$comments}' \
  > /tmp/pcr-review-<num>.json
```

**Response-capture guard**: Redirect the POST response to a file. NEVER `RESP=$(<BOT_GH> gh api ...)` + `echo "$RESP" | jq ...` — command substitution strips trailing LFs and downstream `jq` failures get conflated with POST failure. The `gh api` exit code is the ONLY source of truth for whether the POST landed; parse the response file separately, after.

```bash
<BOT_GH> gh api --method POST /repos/<owner>/<repo>/pulls/<num>/reviews \
  --input /tmp/pcr-review-<num>.json \
  > /tmp/pcr-review-resp-<num>.json
GH_EXIT=$?

# Parse ONLY after deciding success from $GH_EXIT. A jq error here means the
# response is weird, not that the POST failed.
if [ $GH_EXIT -eq 0 ]; then
  jq -r '"id=\(.id)\nhtml_url=\(.html_url)"' /tmp/pcr-review-resp-<num>.json
fi
```

**Idempotency guard (NO blind retry)**: If POST looks failed for ANY reason — non-zero `gh` exit, jq error on the response, malformed body — DO NOT re-POST the same payload until you've verified the prior POST didn't already land. GitHub's reviews API is non-idempotent and submitted reviews CANNOT be deleted (`pending` only, 422 on submitted), so a wrong retry leaves a permanent duplicate on the PR (observed on PR #66: jq parse error on the response was read as POST failure → blind retry → two identical reviews, unrecoverable). Before any retry:

```bash
<BOT_GH> gh api "repos/<owner>/<repo>/pulls/<num>/reviews" --paginate \
  --jq '.[] | select(.user.login == "'$BOT_LOGIN'" and (.body | contains("pcr:<HASH>"))) | {id, html_url, submitted_at}'
```

If a row matches the current run's `pcr:HASH`, the prior POST succeeded — adopt that `review_id` and skip retry. Only retry when NO matching review exists.

`$INLINE_COMMENTS_JSON` is the inline-comments array built separately — when any inline body is multi-line, build it the same way (per-comment `.md` file + `jq --rawfile` + `jq -s` to assemble the array), not by inlining `\n` escapes.

If GitHub rejects an inline comment (line not in diff hunks), retry once with that comment moved into the summary body as `<file>:<line> — <comment>`. Never drop silently.

### 10. Finalize state + 👀→🎉

Update state file:

```bash
STATE_FILE=~/.claude/skills/pr-code-review/state/<owner>__<repo>__<num>.json
mkdir -p "$(dirname "$STATE_FILE")"
jq -n --arg sha "<headRefOid>" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg rid "<review_id>" \
  '{last_head_sha:$sha, last_run_at:$at, last_review_id:$rid}' > "$STATE_FILE"
```

On post success AND `REACTION_ID` captured: DELETE 👀 then POST 🎉.

```bash
<BOT_GH> gh api --method DELETE /repos/<owner>/<repo>/issues/<num>/reactions/$REACTION_ID
<BOT_GH> gh api --method POST -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/issues/<num>/reactions -f content=hooray
```

On post failure: leave 👀 in place (visible unfinished state).

**Report**: review URL (`html_url`), # comments posted, # deduped, codex kept/dropped (if ran).

**If `--auto-reply`**: do NOT stop. Jump straight to the Reply mode pipeline (R1) against the same PR. `headRefOid` and conventions stay loaded — no re-fetch. With `--yes`, R5 is also skipped, making the whole review→reply non-interactive.

## Reply mode pipeline

Entered only with `--reply`. Steps 1–3 already ran. **Still load conventions (step 5)** — replies must respect them. Skip big-PR guard, rate-limit guard, fingerprint dedup, diff review, codex critic, GitHub Review POST.

### R1. Reaction model

Reply mode reacts **per thread** on `comments.nodes[-1].databaseId` (user's latest reply). Init empty `THREAD_REACTIONS: {threadId → reactionId}`. **👀 posts immediately after filtering in R3 — BEFORE the R4 LLM classification call** — and is swapped/removed in R7. The point of 👀 is "bot started looking at this thread", so it must precede the slow classification step, not show up at the end. Do NOT post a PR-body 👀 — that's review mode's signal. Skip all reaction work if `--dry-run`.

**Never prompt the user before posting 👀**. Reactions are status signals, not "writes that need confirmation" — they post unconditionally (even without `--yes`).

### R2. Fetch review threads (GraphQL, user's gh)

```bash
gh api graphql -F owner=<owner> -F repo=<repo> -F num=<num> -f query='
  query($owner:String!, $repo:String!, $num:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$num) {
        reviewThreads(first:100) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id isResolved path line originalLine
            comments(first:100) {
              nodes { databaseId author { login } body createdAt replyTo { databaseId } }
            }
          }
        }
      }
    }
  }'
```

Paginate via `after: endCursor`. Cap at 5 pages, warn if exceeded.

### R3. Filter threads + post 👀 (start signal)

**Step A — Filter.** Keep a thread only if ALL hold:
- `isResolved == false`
- `comments.nodes[0].author.login == <BOT_LOGIN>` (bot started it)
- `comments.nodes[-1].author.login != <BOT_LOGIN>` (someone else has the last word) — **loop guard**

If zero threads remain, report "no threads need a response" and stop.

**Step B — Post 👀 immediately, BEFORE R4.** This is the very next action after filtering — no confirmation prompt, no LLM call, nothing else first. Skip only if `--dry-run`. For each surviving thread, POST 👀 on `comments.nodes[-1].databaseId` (the user's latest reply) and record `RID` in `THREAD_REACTIONS`:

```bash
RID=$(<BOT_GH> gh api --method POST -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/pulls/comments/<last_reply_databaseId>/reactions \
  -f content=eyes --jq .id)
```

The 👀 must be visible on GitHub **before** R4's classification call lands, so the user sees "bot is processing" while waiting. Posting 👀 at R6/R7 instead would defeat the signal — at that point the work is already done.

Per-thread reaction failure → warn + continue (never abort the whole run for a reaction).

### R4. Build context and classify intent

Per thread, gather:
- Original bot comment body (`comments.nodes[0].body`, strip `<!-- pcr:... -->`)
- Full reply history (author + body, in order)
- File at HEAD (cache by path): `gh api "repos/<owner>/<repo>/contents/<path>?ref=<headRefOid>" --jq '.content' | base64 -d`. **ALWAYS use `gh api` here** — `git show <sha>:<path>` / `git cat-file -p <sha>:<path>` from a worktree checkout silently return wrong content (e.g. commit message text instead of the file blob — observed on PR #53). 404 = deleted at HEAD (usually the user removed the offending code).
- Thread's `path` / `line` / `originalLine`
- Loaded `.claude/` conventions

Call Claude per thread (or batches ≤ 5). Force JSON schema:

```json
{
  "threadId": "string (GraphQL node id, passed through unchanged)",
  "intent": "fixed | disagreement | clarification_request | agreement | question",
  "fix_confirmed": "boolean",
  "reply_body": "string (1-3 sentences; match the language of the conversation — Korean if replies are Korean)",
  "should_resolve": "boolean"
}
```

Rules:
- `fix_confirmed = true` ONLY when **both**: the user's reply claims/implies a fix (intent ∈ {`fixed`, `agreement`} with fix statement) AND HEAD file content (or its deletion) actually addresses the original finding. **Don't take the user's word alone.**
- `should_resolve = fix_confirmed`. Never resolve on disagreement or clarification.
- `reply_body` by intent:
  - `fixed && fix_confirmed=true` → ack, e.g. "수정 확인했습니다. 반영해 주셔서 감사합니다."
  - `fixed && fix_confirmed=false` → ask politely where the fix went in, e.g. "해당 위치엔 아직 변경이 안 보이는데, 혹시 다른 곳에서 처리하셨나요?"
  - `disagreement` → weigh against rule/diff. Valid reason → retract gracefully ("지적 감사합니다. 룰 X 기준으로 보면 현 코드가 맞네요. 의견 철회하겠습니다."). Still concerned → restate concern + rule citation in 1 sentence.
  - `clarification_request` / `question` → explain, cite the relevant rule file/section.
  - `agreement` (no fix) → brief ack, no resolve.
- Append `<!-- pcr:reply -->` to every `reply_body`.

Fail-safe: unparseable response or missing `threadId` → **skip that thread**, log warning. Do NOT guess.

### R5. Confirm with the user (always, including `--dry-run`)

Print digest:
- Target / bot login
- Threads found / responding to / will resolve / skipped (counts)
- Per-thread one-liner: `path:line — intent=<…> resolve=<true|false>`
- First 3 reply bodies in full, then "... and N more"

`--dry-run` → write full plan to `/tmp/pcr-replies-<repo>-<num>.md`, print path, stop (overrides `--yes`). Otherwise ask to confirm before any write — unless `--yes` is set (then proceed directly to R6).

### R6. Post replies, then resolve

For each thread, in order:

**Post the reply** (bot's gh, threaded under the original comment). **Quoting guard**: ALWAYS serialize `reply_body` to `/tmp/pcr-reply-<num>-<thread>.json` and post with `--input`. NEVER `-f body="..."` inline — Korean + backticks / `$` / quotes silently corrupt escaping (observed on PR #52: had to delete + repost). **Newline guard** (same as step 9): write `reply_body` to a `.md` file with real LFs (heredoc, not `\n` escapes) and assemble the JSON via `jq --rawfile`, otherwise GitHub renders it as one giant line (observed on PR #53).

```bash
<BOT_GH> gh api --method POST \
  /repos/<owner>/<repo>/pulls/<num>/comments \
  --input /tmp/pcr-reply-<num>-<thread>.json
```

(`root_comment_databaseId` = `comments.nodes[0].databaseId` from R2.)

**If `should_resolve == true`, resolve via GraphQL** (bot's gh):

```bash
<BOT_GH> gh api graphql -F id="<thread.id>" -f query='
  mutation($id:ID!) {
    resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } }
  }'
```

(`thread.id` = GraphQL node ID from R2, NOT a databaseId.)

**Order matters**: reply FIRST, then resolve. If a reply POST fails, log and move on; NEVER resolve a thread whose acknowledgement didn't post.

### R7. Per-thread reaction swap + report

Per thread in `THREAD_REACTIONS` (skip if `--dry-run`), branch on R6 outcome:
- **Resolved** (`should_resolve` AND resolve succeeded): DELETE 👀 + POST 🎉.
- **Reply posted, not resolved** (disagreement / clarification / question): DELETE 👀, no 🎉. Thread stays open; 👀 removed so it doesn't look in-progress.
- **Reply POST failed**: leave 👀, no 🎉.

```bash
# Delete 👀
<BOT_GH> gh api --method DELETE /repos/<owner>/<repo>/pulls/comments/<last_reply_databaseId>/reactions/<RID>
# Post 🎉 (resolved branch only)
<BOT_GH> gh api --method POST -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/pulls/comments/<last_reply_databaseId>/reactions -f content=hooray
```

Report: `<N>` replies posted, `<M>` resolved, `<K>` failed (with reasons), `<S>` skipped. Include per-thread reaction status on swap failures.

**Do NOT update the rate-limit state file** — reply mode doesn't participate.

## Notes

- **Dry-run → post follow-up**: after `--dry-run` finishes in the same conversation, if the user asks to post ("게시", "post", "올려", "그대로 게시" etc.) WITHOUT re-invoking `/pr-code-review`, treat it as a continuation of the same run. Reuse the prepared summary + inline comments from `/tmp/pcr-<repo>-<num>.md` verbatim — do NOT re-fetch the PR, re-load conventions, re-review the diff, or re-call codex. Resume at step 9 (post the review), then step 10 (state + 👀→🎉 swap; 👀 is already on the PR from step 4.5). If the head SHA changed since the dry-run, abort the shortcut and tell the user to re-run.
- Bot PAT scopes: `Contents: Read` (`.claude/` files), `Issues: write` (👀/🎉), `Pull requests: R/W` (review + GraphQL). All set in `SETUP.md`.
- `bot-gh-config/` is `700` — do not back up to shared storage.
- Local clone path convention: `~/documents/personal/git/<repo-name>` (GitHub repo name verbatim).
- Rate-limit state: per-PR-per-head-SHA. Force-push (new SHA) bypasses; `--force` overrides everything.
- Loop guard relies on "last commenter ≠ bot". Renaming the bot mid-flight temporarily breaks it; `<!-- pcr:reply -->` is a secondary safety net.
- `--with-codex` needs `codex` on `PATH` + valid login (`codex login` or `OPENAI_API_KEY`). Runs `--sandbox read-only` — cannot mutate the tree.
