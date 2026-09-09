#!/usr/bin/env bash
# migration-safety-reminder.sh — PostToolUse hook (matcher: Bash)
#
#   - After `drizzle-kit generate` (or `pnpm db:generate`,
#     scripts/generate-migration.sh) succeeds: remind to run the
#     destructive-DDL check and to read the generated SQL. The check command
#     depends on the cwd: `node scripts/check-destructive-migrations.js` in the
#     framework repo, `pnpm db:check-destructive` in a generated api/ project.
#   - After any `drizzle-kit push` (or `pnpm db:push`): remind that push is
#     dev-only and production uses migrations.
#
# Contract: JSON on stdin (see lib/hook-input.sh). Always exits 0. Stdout is
# surfaced to Claude as a reminder; no output means silent.

set -u
trap 'exit 0' ERR

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HOOK_DIR/../../scripts/lib/common.sh" ]]; then
  # shellcheck source=../../scripts/lib/common.sh
  source "$HOOK_DIR/../../scripts/lib/common.sh"
fi
# shellcheck source=lib/hook-input.sh
source "$HOOK_DIR/lib/hook-input.sh"

hook_skip_requested && exit 0
CMD="$(hook_tool_command)"
[[ -n "$CMD" ]] || exit 0

PUSH_RE='drizzle-kit[[:space:]]+push|db:push'
GENERATE_RE='drizzle-kit[[:space:]]+generate|db:generate|generate-migration\.sh'

if printf '%s' "$CMD" | grep -qE -- "$PUSH_RE"; then
  echo "[migration-safety] drizzle-kit push applied schema changes straight to the database. That is dev-only: staging and production take generated migrations (pnpm drizzle-kit generate, review the SQL, pnpm drizzle-kit migrate)."
fi

if printf '%s' "$CMD" | grep -qE -- "$GENERATE_RE"; then
  OUT="$(hook_tool_output)"
  if [[ -n "$OUT" ]] \
     && ! printf '%s' "$OUT" | grep -qi 'no schema changes' \
     && ! printf '%s' "$OUT" | grep -qiE '(^|[^[:alnum:]])(error|failed)([^[:alnum:]]|$)|✗|ERR_' \
     && printf '%s' "$OUT" | grep -qiE 'migration|[[:alnum:]_-]+\.sql'; then
    if [[ -f scripts/check-destructive-migrations.js ]]; then
      CHECK="node scripts/check-destructive-migrations.js"
    elif [[ -f package.json ]] && grep -q '"db:check-destructive"' package.json 2>/dev/null; then
      CHECK="pnpm db:check-destructive"
    elif [[ -f api/package.json ]] && grep -q '"db:check-destructive"' api/package.json 2>/dev/null; then
      CHECK="cd api && pnpm db:check-destructive"
    else
      CHECK="the destructive-DDL check (node scripts/check-destructive-migrations.js in the framework repo, pnpm db:check-destructive in a generated api/ project)"
    fi
    echo "[migration-safety] Migration generated. Before applying it: run ${CHECK} to flag destructive DDL (DROP, ALTER COLUMN ... TYPE, SET NOT NULL), read the new SQL file, and apply it with drizzle-kit migrate (never push) outside dev."
  fi
fi
exit 0
