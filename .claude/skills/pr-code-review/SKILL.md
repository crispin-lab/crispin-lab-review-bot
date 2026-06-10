---
name: pr-code-review
description: Review a GitHub PR in the crispin-lab org and post inline + summary review comments using a dedicated bot GitHub account, or (with --reply) respond to replies on prior bot review threads and auto-resolve confirmed-fixed conversations. Loads the target repo's .claude/ conventions, dedups against prior bot comments, and posts as a single GitHub Review. Use when the user asks to review a PR by URL or owner/repo#number form, e.g. "/pr-code-review crispin-lab/crispin-lab-frontend#42" or "/pr-code-review https://github.com/crispin-lab/crispin-lab-backend/pull/17 --reply".
---

# pr-code-review

Two modes:
- **Review mode** (default) — review the diff and post a single GitHub Review with inline comments + summary as the bot.
- **Reply mode** (`--reply`) — respond to replies on prior bot review threads; auto-resolve threads when the fix is confirmed at HEAD.

**Bot account isolation**: every bot-side `gh` call must use `GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config`. Below this is shortened to `<BOT_GH>` — expand it in real commands. **Never** mutate the user's primary `gh` auth.

## Args

`/pr-code-review <target> [flags]`

`<target>`: `owner/repo#NUMBER` or PR URL. `owner` MUST be `crispin-lab`.

Flags:
- `--dry-run` — both modes. No posting; write plan to `/tmp/pcr-<repo>-<num>.md` (review) or `/tmp/pcr-replies-<repo>-<num>.md` (reply).
- `--focus <cat>[,...]` — review only. Limit findings to: `correctness`, `security`, `conventions`, `reuse`, `perf`, `tests`.
- `--force` — review only. Bypass big-PR + rate-limit guards.
- `--with-codex` — review only. Codex CLI critic pass between review and post.
- `--reply` — switch to reply mode (rate-limit guard does not apply).
- `--help`, `-h` — print help and stop.

Unknown flag → fail clearly. Missing/unparseable target → ask the user. `--reply` + review-only flags → warn (ignored) but continue.

## Shared pipeline (steps 0–3)

After step 3: `--reply` → jump to **Reply mode**, else continue with **Review mode**.

### 0. Help short-circuit

If args contain `--help` or `-h`, print `HELP.ko.md` and stop. Runs before everything — no API calls, no bot setup needed:

```bash
cat ~/.claude/skills/pr-code-review/HELP.ko.md
```

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

If `closed`/`merged`/`draft`, ask whether to continue.

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

If not `--dry-run`, post 👀 on the PR and capture the reaction id (held for step 10):

```bash
REACTION_ID=$(<BOT_GH> gh api --method POST \
  -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/issues/<num>/reactions \
  -f content=eyes --jq .id)
```

On 👀 failure (e.g. PR locked): warn and continue — review still proceeds.

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

Summary (3–6 sentences): scope, top risks, 1–2 themes, conventions loaded yes/no, # findings deduped.

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

Apply verdicts: `keep:true` → keep; `keep:false` → drop and log reason; missing fingerprint or unparseable output → **keep** (fail-open, never lose findings to critic errors). Append to summary: `Codex critic: kept N / dropped M` or `Codex critic: parse failed, all findings kept`.

### 8. Confirm before posting

Print:
- Target: `owner/repo#NUMBER` @ `<headRefOid[:7]>`
- Posting as: `<BOT_LOGIN>`
- Conventions: `<N>` rule files (source: local clone | gh API | none)
- Linked issues
- Findings by category, dedup count, codex critic kept/dropped (if ran)
- Summary preview + first 3 inline comments (then "... and N more")

Ask for confirmation. `--dry-run` → write full markdown to `/tmp/pcr-<repo>-<num>.md`, print path, stop.

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

<BOT_GH> gh api --method POST /repos/<owner>/<repo>/pulls/<num>/reviews \
  --input /tmp/pcr-review-<num>.json
```

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

## Reply mode pipeline

Entered only with `--reply`. Steps 1–3 already ran. **Still load conventions (step 5)** — replies must respect them. Skip big-PR guard, rate-limit guard, fingerprint dedup, diff review, codex critic, GitHub Review POST.

### R1. Reaction model

Reply mode reacts **per thread** on `comments.nodes[-1].databaseId` (user's latest reply). Init empty `THREAD_REACTIONS: {threadId → reactionId}`. 👀 posts at end of R3 (only on threads we'll process); swap in R7. Do NOT post a PR-body 👀 — that's review mode's signal. Skip all reaction work if `--dry-run`.

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

### R3. Filter threads needing a response

Keep a thread only if ALL hold:
- `isResolved == false`
- `comments.nodes[0].author.login == <BOT_LOGIN>` (bot started it)
- `comments.nodes[-1].author.login != <BOT_LOGIN>` (someone else has the last word) — **loop guard**

If zero threads remain, report "no threads need a response" and stop.

**Post 👀 on each surviving thread's latest reply** (skip if `--dry-run`). Record in `THREAD_REACTIONS`:

```bash
RID=$(<BOT_GH> gh api --method POST -H "Accept: application/vnd.github+json" \
  /repos/<owner>/<repo>/pulls/comments/<last_reply_databaseId>/reactions \
  -f content=eyes --jq .id)
```

Per-thread reaction failure → warn + continue (never abort the whole run for a reaction).

### R4. Build context and classify intent

Per thread, gather:
- Original bot comment body (`comments.nodes[0].body`, strip `<!-- pcr:... -->`)
- Full reply history (author + body, in order)
- File at HEAD (cache by path): `gh api "repos/<owner>/<repo>/contents/<path>?ref=<headRefOid>" --jq '.content' | base64 -d`. 404 = deleted at HEAD (usually the user removed the offending code).
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

`--dry-run` → write full plan to `/tmp/pcr-replies-<repo>-<num>.md`, print path, stop. Otherwise ask to confirm before any write.

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

- Bot PAT scopes: `Contents: Read` (`.claude/` files), `Issues: write` (👀/🎉), `Pull requests: R/W` (review + GraphQL). All set in `SETUP.md`.
- `bot-gh-config/` is `700` — do not back up to shared storage.
- Local clone path convention: `~/documents/personal/git/<repo-name>` (GitHub repo name verbatim).
- Rate-limit state: per-PR-per-head-SHA. Force-push (new SHA) bypasses; `--force` overrides everything.
- Loop guard relies on "last commenter ≠ bot". Renaming the bot mid-flight temporarily breaks it; `<!-- pcr:reply -->` is a secondary safety net.
- `--with-codex` needs `codex` on `PATH` + valid login (`codex login` or `OPENAI_API_KEY`). Runs `--sandbox read-only` — cannot mutate the tree.
