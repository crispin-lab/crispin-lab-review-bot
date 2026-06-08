# pr-code-review — one-time setup

This skill posts PR review comments using a **dedicated bot GitHub account**, isolated from your primary `gh` CLI auth via a separate `GH_CONFIG_DIR`.

## 1. Log in as the bot

Run this **once**, while signed into the bot account in your browser (or with the bot's PAT in hand):

```bash
GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config gh auth login \
  --hostname github.com \
  --git-protocol https \
  --web
```

Or with a fine-grained PAT:

```bash
GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config gh auth login \
  --hostname github.com \
  --git-protocol https \
  --with-token < /path/to/bot-pat.txt
```

## 2. Required PAT scopes

Fine-grained PAT on the bot account, granted on the target repositories in `crispin-lab`:

- **Repository access**: each repo you want to review (or org-wide if appropriate)
- **Permissions**:
  - Contents: Read
  - Metadata: Read
  - Pull requests: **Read and write**
  - Issues: Read and write (for PR-level comments — same endpoint)

## 3. Verify

```bash
GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config gh auth status
GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config gh api user --jq .login
```

The second command should print the bot account's login.

## 4. Sanity check (optional)

Post a throwaway issue comment from a test PR to confirm permissions:

```bash
GH_CONFIG_DIR=~/.claude/skills/pr-code-review/bot-gh-config \
  gh pr comment <PR-URL> --body "bot auth check — please ignore"
```

Delete it via the GitHub UI when done.

## Notes

- Your primary `gh` auth (at `~/.config/gh/`) is untouched.
- The `bot-gh-config/` directory has 700 permissions. Don't commit it or sync it to shared backups.
- To rotate the bot's PAT later, re-run step 1 with the new token.
