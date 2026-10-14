#!/usr/bin/env bash
# hook-version: 1.0.0
# git/block-tags.sh
HOOK_VERSION="1.0.0"
#
# Claude Code PreToolUse hook — blocks Claude from creating or pushing git tags
# (and from cutting GitHub releases) before the Bash tool executes.
#
# Why: CarkedIt releases are shipped from the deployment page, NOT from Claude.
# The repos auto-deploy prod/staging the moment a `v<version>` tag is pushed, so a
# stray `git tag vX && git push origin vX` would silently deploy with no gate.
#
# Blocks (hard deny — never fails open):
#   1. Pushing a tag         — git push with --tags / --follow-tags / refs/tags/ or a v<version> ref
#   2. Creating/deleting a tag — git tag with a create/delete/move flag or a bare tag name
#   3. Cutting a release     — gh release create | delete | edit
#
# Allowed: read-only tag listing (git tag, git tag -l, git tag --sort, git tag --contains, ...).
#
# Input:  JSON on stdin — { "tool_name": "Bash", "tool_input": { "command": "..." } }
# Output: on block, emits PreToolUse deny JSON on stdout + a message on stderr, exit 2.

set -uo pipefail

# --- Helpers ---
red() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
dim() { printf '\033[2m%s\033[0m\n' "$*" >&2; }

# --- Parse input ---
INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Nothing to inspect → allow.
[ -z "$CMD" ] && exit 0

# Emit a hard deny and stop the tool call. Uses the permissionDecision API AND a
# non-zero exit (2) so the block holds even if structured output is ignored — a
# safety guardrail must never fail open.
deny() {
  local reason="$1"
  jq -n --arg r "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $r
    }
  }'
  red "BLOCKED: $reason"
  dim "  Releases ship from the deployment page. If you genuinely need this, run it yourself outside Claude."
  exit 2
}

# Boundaries use POSIX classes, not `\b` (BSD grep/sed on macOS doesn't reliably
# support `\b`). Dangerous verbs are anchored to a COMMAND position — start of
# line, or right after a shell separator ( ; & | ( { ) — so a tag/push/release
# merely MENTIONED in prose (a `commit -m` / `pr --body` message) is not mistaken
# for a real invocation. For long messages that contain literal example commands,
# pass them via a body/message file so they aren't part of the command string.
BNDRY='(^|[;&|({])[[:space:]]*'

# ── 1. Pushing a tag ────────────────────────────────────────────────────────
# An actual `git push` (incl. `cd … && git push`) whose args carry a tag:
# --tags / --follow-tags / an explicit refs/tags/ refspec / a v* or vs* ref.
if printf '%s' "$CMD" | grep -Eq "${BNDRY}git[[:space:]]+push[[:space:]][^;&|]*(--tags|--follow-tags|refs/tags/|[[:space:]/]vs?[0-9]+(\.[0-9]+)*([[:space:]]|\$))"; then
  deny "pushing a git tag triggers a production/staging deploy (v* = prod, vs* = staging)."
fi

# ── 2. Creating / deleting / moving a tag ───────────────────────────────────
# An actual `git tag` with a create/delete/move flag OR a bare tag name. Read-
# only forms stay allowed: bare `git tag`, -l/--list/-n/--contains/--points-at/
# --sort/--format/--merged/-v/--verify, and `git tag | grep …` / `git tag > f`.
if printf '%s' "$CMD" | grep -Eq "${BNDRY}git[[:space:]]+tag[[:space:]]+(-a|-s|-d|-f|-m|-F|-u|--annotate|--sign|--delete|--force|--message|--file|--local-user|--create-reflog|[^-[:space:]|;&<>()])"; then
  deny "creating, moving, or deleting a git tag is disabled (a v* tag auto-deploys). 'git tag -l' listing is still allowed."
fi

# ── 3. Cutting a GitHub release ─────────────────────────────────────────────
# A GitHub release publishes a tag → deploy.
if printf '%s' "$CMD" | grep -Eq "${BNDRY}gh[[:space:]]+release[[:space:]]+(create|delete|edit)"; then
  deny "creating/editing a GitHub release publishes a tag and triggers a deploy."
fi

exit 0
