---
name: pr-code-review
description: Review a GitHub PR in the crispin-lab org and post inline + summary as one GitHub Review using a dedicated bot account. With `--reply`, respond to user replies on prior bot review threads and auto-resolve confirmed fixes. Loads the target repo's `.claude/` conventions and dedups against prior bot comments. Invoke for `owner/repo#NUMBER` or PR URLs (crispin-lab org).
---

# pr-code-review

Two modes:
- **Review mode** (default) — review the diff and post a single GitHub Review with inline + summary as the bot.
- **Reply mode** (`--reply`) — respond to replies on prior bot review threads; auto-resolve when the fix is confirmed at HEAD.

**Bot account isolation**: every bot-side `gh` call MUST use `GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config` (shortened to `<BOT_GH>` below). Never mutate the user's primary `gh` auth.

## Help short-circuit (do this FIRST)

If args contain `--help` / `-h` anywhere: Read `~/.claude/skills/pr-code-review/HELP.ko.md` and output its contents **verbatim**. No summary, no target parse, no other tool. Stop. Missing target is fine when `--help` is present.

## Args

`/pr-code-review <target> [flags]`

`<target>`: `owner/repo#NUMBER` or PR URL. `owner` MUST be `crispin-lab`.

Flags:
- `--dry-run` — both modes. No posting; write plan to `/tmp/pcr-<repo>-<num>.md` (review) or `/tmp/pcr-replies-<repo>-<num>.md` (reply).
- `--yes`, `-y` — both modes. **Auto-answer every interactive prompt with "continue"**: step 3 closed/merged/draft, step 4 big-PR (review all, never "skip"/"bail"), step 8 review preview, step 8 critic-shutout override (auto-includes all critic-dropped findings — safer than silently posting empty when critic rejected real findings), R5 reply digest, any pre-write self-check. Only non-prompt refusals stop the run: rate-limit (step 4.5), missing/invalid target, bot not logged in, GitHub API errors. `--force` to bypass rate-limit. `--dry-run` overrides `--yes` (still stops at step 8 / R5 to write the plan file). Rule of thumb: typing "Want me to ...?" / "Continue?" under `--yes` = broken contract.
- `--focus <cat>[,...]` — review only. Limit findings to: `correctness`, `security`, `conventions`, `reuse`, `perf`, `tests`.
- `--force` — review only. Bypass big-PR + rate-limit guards. (`--yes` already auto-continues big-PR; use `--force` for rate-limit override.)
- `--with-codex` — review only. Codex CLI critic pass between review and post.
- `--auto-reply` — review only. After step 10, chain into Reply mode (R1) on the same PR. Combine with `--yes` for fully non-interactive review→reply.
- `--reply` — switch to reply mode (rate-limit guard does not apply).
- `--help`, `-h` — print help and stop.

Unknown flag → fail clearly. Missing/unparseable target → ask the user. `--reply` + review-only flags → warn (ignored) but continue.

## Shared pipeline (steps 1–3)

After step 3: `--reply` → jump to **Reply mode**, else **Review mode**.

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

If `closed` / `merged` / `draft`: ask whether to continue — UNLESS `--yes` (then warn once and continue).

**Linked issues**: scan PR body for `(?:Fixes|Closes|Resolves|Refs)\s+#(\d+)` (case-insensitive), cap 5:

```bash
gh issue view <n> --repo <owner>/<repo> --json title,body,labels
```

## Review mode (steps 4–10)

### 4. Big-PR guard

`total_changes = additions + deletions`. If `changedFiles > 50` OR `total_changes > 2000`: warn (numbers + largest files) and ask continue / skip / bail. Skip = top 20 files by churn. `--force` skips guard entirely. `--yes` auto-answers **continue (review all)** — print warning to the report, do not wait, never default to skip/bail.

### 4.5. Rate-limit guard + 👀 (start signal)

State file: `~/.claude/skills/pr-code-review/state/<owner>__<repo>__<num>.json` = `{last_run_at, last_head_sha, last_review_id}`.

**Refuse** iff `last_head_sha == headRefOid` AND `now - last_run_at < 10 min` AND no `--force`. Print target / last run / elapsed / "use `--force` or wait <N>m". Different head SHA = always re-review.

**Post 👀 immediately** after the rate-limit guard passes — BEFORE step 5 (conventions) and step 7 (review). No confirm prompt, no LLM call first. Runs on every `--dry-run` too. Capture `REACTION_ID` for step 10. Reactions are status signals — never gated by `--yes`, never prompted.

```bash
REACTION_ID=$(<BOT_GH> gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/issues/<num>/reactions \
  -f content=eyes --jq .id)
```

On 👀 failure (PR locked etc.): warn + continue. In the dry-run → post follow-up flow (Notes), do NOT re-post 👀 — step 10's swap reuses the existing `REACTION_ID`.

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

Fingerprints = hidden HTML markers `<!-- pcr:HASH -->`. Per finding:

```
hash = sha1(lower(path) + ":" + line + ":" + normalized_first_80_chars_of_body)[:12]
```

(`normalized` = lowercased + whitespace collapsed.) Skip findings whose hash is already seen. Append `<!-- pcr:HASH -->` to every new comment body. Summary fingerprint = `"summary:<num>:<headRefOid>"`. Reruns idempotent across force-pushes.

### 7. Review the diff

Per file (after big-PR-guard filtering):
- Added lines only (`+`, excluding `+++` headers).
- Categorize: `correctness`, `security`, `conventions`, `reuse`, `perf`, `tests`. Skip style/format unless `--focus conventions`.
- Apply `--focus` filter.
- Each finding: `path`, `line` (new-file line number), `side: "RIGHT"`, `body` (1–3 sentences, actionable, quote the offending snippet). Cite rule file/section on convention findings.
- Compute fingerprint; skip if seen.

Summary uses these **EXACT** section headers in this order — never rename, translate, or reorder. Body is Korean prose (English if the PR conversation is English). Omit a section entirely (header + body) when empty; never leave a header with empty body.

```
## Scope
<1 line: N files, +X/-Y. What the PR does.>

## Risks
- <bullet per finding-level risk; one line each. Omit section if zero findings.>

## Themes
- <1–2 bullets on cross-cutting patterns the reviewer noticed.>

## Conventions
<one line: N rule files loaded from {local clone | gh API} @ <sha[:7]> | none loaded (404).>

## Dedup
<one line: N prior bot findings still apply, M new findings this run. Or: no prior findings.>
```

If `--with-codex` ran, append below `## Dedup`: `Codex critic: kept N / dropped M.` (or `parse failed, all findings kept`), then for each drop one indented line `  - <fingerprint[:8]> path:line — <reason, ≤80 chars>`. Do NOT add a new section header for it.

Guardrails:
- **Fewer, higher-confidence** by default. <70% sure → drop (unless `--focus` says otherwise).
- Skip generated files, lockfiles, snapshots, build outputs.
- No style/naming unless a rule file explicitly says so.

Zero new findings (after step 7.4 sweep) → post summary review with `event: "COMMENT"`, empty `comments`, body saying so (e.g. "No new findings — N previous findings still apply.").

### 7.4. Multi-axis sweep (mechanical, never skip)

After step 7 per-file pass — before critic. 4 yes/no checks on the diff as a whole; any "no" → add finding (fingerprint + dedup per step 7). Runs even when step 7 finds zero. Findings from sweep feed step 7.5 critic and the summary like any other.

1. **Fallback symmetry** — for each changed function with ≥2 callers, does its parse-fail / exception-swallow fallback have the same safety sign at every caller? (Same `parseOrEmpty` returning empty → deny-safe at read but silent corruption at write = raise.)
2. **Irreversible op** — `DROP COLUMN` / `DELETE` / `TRUNCATE` / forward-only migration / one-way data deletion: is recovery-path absence raised, **regardless of author intent**? Intent ≠ reversibility — flag the irreversibility axis separately even when the deletion itself is intended.
3. **PR-stated invariant** — does the PR body assert an explicit invariant (deny-by-default, single-source-of-truth, "X is no longer trusted", etc.)? Is **every** changed file consistent with it? Partial violations are not speculative.
4. **Guard side-effect completeness** — new production guard added (early-return, idempotency skip, etc.)? Does the spec assert `verify(never())` on **every** IO the guard skips, not just the first one? Partial pinning leaves regressions unguarded.

### 7.5. Codex critic pass (only `--with-codex`)

Skip entirely if flag not set.

Preflight: `command -v codex >/dev/null || { echo "codex CLI not found"; exit 1; }`

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
You are a code-review critic. Read JSON on stdin. For each finding, decide if it is a real, actionable issue given the diff and conventions. Be conservative: reject speculative findings, findings outside the diff scope, and findings contradicted by the conventions or PR context. Exception: if the PR body asserts an explicit invariant (deny-by-default, single-source-of-truth, irreversibility concern, etc.), do NOT drop a finding that points at a partial violation of that invariant on grounds of unproven exploitability — invariant-consistency is not speculation. Output ONLY {"verdicts":[{"fingerprint":string,"keep":boolean,"reason":string}]}. No prose, no fences.
PROMPT
)" < /tmp/pcr-critic-<num>-input.json > /tmp/pcr-critic-<num>-output.json
```

(Drop `--skip-git-repo-check` if unsupported.)

Apply: `keep:true` → keep; `keep:false` → drop + log reason; missing fingerprint or unparseable output → **keep** (fail-open). Codex line is appended per step 7's template.

### 8. Confirm before posting

Print:
- Target: `owner/repo#NUMBER` @ `<headRefOid[:7]>`
- Posting as: `<BOT_LOGIN>`
- Conventions: `<N>` rule files (source: local clone | gh API | none)
- Linked issues
- Findings by category, dedup count, codex kept/dropped (if ran)
- Summary preview + first 3 inline comments (then "... and N more")

Ask for confirmation — UNLESS `--yes` (proceed to step 9). `--dry-run` → write full markdown to `/tmp/pcr-<repo>-<num>.md`, print path, stop (overrides `--yes`). The 👀 from step 4.5 stays on the PR; "post" in the same conversation = dry-run → post shortcut (Notes).

**Critic-shutout override** (`--with-codex` only): if `kept == 0` AND `dropped >= 1`, surface the drop reasons (already in Dedup) explicitly before confirm. Interactive → ask "Critic rejected all N findings. Pick: [y]es include all / [N]o post empty / [s]elect subset". Under `--yes` → auto-include all dropped findings (safer than silently posting empty when critic rejected real findings); note the override in the final report.

### 9. Post the review (bot's gh)

`event` is **always** `COMMENT` — never `APPROVE` / `REQUEST_CHANGES`.

Payload for `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`:

```json
{
  "commit_id": "<headRefOid>",
  "body": "<summary including pcr:HASH>",
  "event": "COMMENT",
  "comments": [{ "path": "src/foo.ts", "line": 42, "side": "RIGHT", "body": "... <!-- pcr:HASH -->" }]
}
```

**Newline guard** (PR #53): never inline `\n` escapes in a body passed via `jq --arg` / `-f body=...` — `--arg` is literal so `\n` ships as `\\n` and GitHub renders one giant line. Write bodies to `.md` files with real LFs via heredoc and pull in with `jq --rawfile`. Same rule for multi-line inline comments.

```bash
cat > /tmp/pcr-summary-<num>.md <<'EOF'
<summary text with actual line breaks>

<!-- pcr:HASH -->
EOF

jq -n \
  --arg commit_id "<headRefOid>" \
  --rawfile body /tmp/pcr-summary-<num>.md \
  --argjson comments "$INLINE_COMMENTS_JSON" \
  '{commit_id:$commit_id, body:$body, event:"COMMENT", comments:$comments}' \
  > /tmp/pcr-review-<num>.json
```

**Response-capture guard**: redirect POST response to a file. Never `RESP=$(<BOT_GH> gh api ...)` + `jq <<< "$RESP"` — command substitution strips trailing LFs and a downstream jq error gets misread as POST failure. `gh api` exit code is the ONLY source of truth for POST success; parse the response file separately, after.

```bash
<BOT_GH> gh api --method POST /repos/<owner>/<repo>/pulls/<num>/reviews \
  --input /tmp/pcr-review-<num>.json \
  > /tmp/pcr-review-resp-<num>.json
GH_EXIT=$?

if [ $GH_EXIT -eq 0 ]; then
  jq -r '"id=\(.id)\nhtml_url=\(.html_url)"' /tmp/pcr-review-resp-<num>.json
fi
```

**No blind retry** (PR #66): GitHub reviews API is non-idempotent and submitted reviews CANNOT be deleted (`pending` only, 422 on submitted). Before any retry, verify the prior POST didn't land:

```bash
<BOT_GH> gh api "repos/<owner>/<repo>/pulls/<num>/reviews" --paginate \
  --jq '.[] | select(.user.login == "'$BOT_LOGIN'" and (.body | contains("pcr:<HASH>"))) | {id, html_url, submitted_at}'
```

If a row matches the current run's `pcr:HASH`, adopt that `review_id` — skip retry. Retry only when no match exists.

`$INLINE_COMMENTS_JSON` = inline-comments array built separately. Multi-line inline bodies follow the same heredoc + `--rawfile` + `jq -s` pattern — never inline `\n`.

If GitHub rejects an inline comment (line not in diff hunks), retry once with the comment moved into the summary body as `<file>:<line> — <comment>`. Never drop silently.

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

On post failure: leave 👀 in place.

**Report**: review URL (`html_url`), # comments posted, # deduped, codex kept/dropped (if ran).

**If `--auto-reply`**: jump straight to Reply mode (R1) on the same PR. `headRefOid` and conventions stay loaded — no re-fetch. With `--yes`, R5 is also skipped → fully non-interactive review→reply.

## Reply mode pipeline

Entered only with `--reply`. Steps 1–3 already ran. **Still load conventions (step 5)** — replies must respect them. Skip big-PR guard, rate-limit guard, fingerprint dedup, diff review, codex critic, GitHub Review POST.

### R1. Reaction model

Reacts **per thread** on `comments.nodes[-1].databaseId` (user's latest reply). Init `THREAD_REACTIONS: {threadId → reactionId} = {}`. 👀 posts at R3 step B (immediately after filter, BEFORE R4 LLM call); swapped/removed in R7. Skip all reaction work if `--dry-run`. Do NOT post a PR-body 👀 — that's review mode's signal. Reactions are status signals — unconditional, no `--yes` gate, no confirm prompt.

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

Paginate via `after: endCursor`. Cap 5 pages, warn if exceeded.

### R3. Filter threads + post 👀 (start signal)

**Step A — Filter.** Keep a thread only if ALL hold:
- `isResolved == false`
- `comments.nodes[0].author.login == <BOT_LOGIN>` (bot started it)
- `comments.nodes[-1].author.login != <BOT_LOGIN>` (someone else has the last word) — **loop guard**

Zero remaining → report "no threads need a response" and stop.

**Step B — Post 👀** on each surviving thread's `comments.nodes[-1].databaseId`, BEFORE R4. No prompt, no LLM call first. Skip if `--dry-run`. Record `RID` in `THREAD_REACTIONS`:

```bash
RID=$(<BOT_GH> gh api --method POST -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/pulls/comments/<last_reply_databaseId>/reactions \
  -f content=eyes --jq .id)
```

Per-thread reaction failure → warn + continue (never abort the run for a reaction).

### R4. Build context and classify intent

Per thread, gather:
- Original bot comment body (`comments.nodes[0].body`, strip `<!-- pcr:... -->`)
- Full reply history (author + body, in order)
- File at HEAD (cache by path): `gh api "repos/<owner>/<repo>/contents/<path>?ref=<headRefOid>" --jq '.content' | base64 -d`. **ALWAYS use `gh api` here** — `git show <sha>:<path>` from a worktree silently returns wrong content (e.g. commit message text instead of file blob, PR #53). 404 = deleted at HEAD.
- Thread's `path` / `line` / `originalLine`
- Loaded `.claude/` conventions

Call Claude per thread (or batches ≤ 5). Force JSON schema:

```json
{
  "threadId": "string (GraphQL node id, passed through unchanged)",
  "intent": "fixed | disagreement | clarification_request | agreement | question",
  "fix_confirmed": "boolean",
  "reply_body": "string (1-3 sentences; match conversation language — Korean if replies are Korean)",
  "should_resolve": "boolean"
}
```

Rules:
- `fix_confirmed = true` ONLY when **both**: user reply claims/implies a fix (intent ∈ {`fixed`, `agreement`} with fix statement) AND HEAD content (or its deletion) actually addresses the original finding. **Don't take the user's word alone.**
- `should_resolve = fix_confirmed`. Never resolve on disagreement or clarification.
- `reply_body` by intent:
  - `fixed && fix_confirmed=true` → ack, e.g. "수정 확인했습니다. 반영해 주셔서 감사합니다."
  - `fixed && fix_confirmed=false` → ask politely, e.g. "해당 위치엔 아직 변경이 안 보이는데, 혹시 다른 곳에서 처리하셨나요?"
  - `disagreement` → weigh against rule/diff. Valid reason → retract gracefully ("지적 감사합니다. 룰 X 기준으로 보면 현 코드가 맞네요. 의견 철회하겠습니다."). Still concerned → restate concern + rule citation in 1 sentence.
  - `clarification_request` / `question` → explain, cite the relevant rule file/section.
  - `agreement` (no fix) → brief ack, no resolve.
- Append `<!-- pcr:reply -->` to every `reply_body`.

Fail-safe: unparseable response or missing `threadId` → **skip that thread**, log warning. Do NOT guess.

### R5. Confirm with the user

Print digest:
- Target / bot login
- Threads found / responding to / will resolve / skipped (counts)
- Per-thread one-liner: `path:line — intent=<…> resolve=<true|false>`
- First 3 reply bodies in full, then "... and N more"

`--dry-run` → write full plan to `/tmp/pcr-replies-<repo>-<num>.md`, print path, stop (overrides `--yes`). Otherwise ask to confirm — UNLESS `--yes` (proceed to R6).

### R6. Post replies, then resolve

For each thread, in order:

**Post the reply** (bot's gh, threaded under root). **Quoting + newline guards** (PR #52, #53): serialize `reply_body` via heredoc to a `.md` file + `jq --rawfile` to `/tmp/pcr-reply-<num>-<thread>.json`, post with `--input`. Never `-f body="..."` inline (Korean + backticks/`$`/quotes silently corrupt escaping). Never inline `\n` escapes.

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

**Order matters**: reply FIRST, then resolve. If reply POST fails, log + move on; NEVER resolve a thread whose acknowledgement didn't post.

### R7. Per-thread reaction swap + report

Per thread in `THREAD_REACTIONS` (skip if `--dry-run`), branch on R6 outcome:
- **Resolved** (`should_resolve` AND resolve succeeded): DELETE 👀 + POST 🎉.
- **Reply posted, not resolved** (disagreement / clarification / question): DELETE 👀, no 🎉.
- **Reply POST failed**: leave 👀, no 🎉.

```bash
# Delete 👀
<BOT_GH> gh api --method DELETE /repos/<owner>/<repo>/pulls/comments/<last_reply_databaseId>/reactions/<RID>
# Post 🎉 (resolved branch only)
<BOT_GH> gh api --method POST -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/pulls/comments/<last_reply_databaseId>/reactions -f content=hooray
```

Report: `<N>` replies posted, `<M>` resolved, `<K>` failed (with reasons), `<S>` skipped. Per-thread reaction status on swap failures.

**Do NOT update the rate-limit state file** — reply mode doesn't participate.

## Notes

- **Dry-run → post follow-up**: after `--dry-run` in the same conversation, "게시" / "post" / "올려" without re-invoking `/pr-code-review` continues the same run. Reuse `/tmp/pcr-<repo>-<num>.md` verbatim — no re-fetch, no re-load, no re-codex. Resume at step 9, then step 10 (👀 from step 4.5 stays for the 👀→🎉 swap). If head SHA changed since dry-run, abort and tell the user to re-run.
- Bot PAT scopes: `Contents: Read` (`.claude/`), `Issues: write` (👀/🎉), `Pull requests: R/W` (review + GraphQL). See `SETUP.md`.
- `bot-gh-config/` is `700` — do not back up to shared storage.
- Local clone path: `~/documents/personal/git/<repo-name>` (GitHub repo name verbatim).
- Rate-limit state is per-PR-per-head-SHA. Force-push (new SHA) bypasses; `--force` overrides.
- Loop guard relies on "last commenter ≠ bot". `<!-- pcr:reply -->` is a secondary safety net.
- `--with-codex` needs `codex` on `PATH` + valid login (`codex login` or `OPENAI_API_KEY`). Runs `--sandbox read-only`.
