#!/usr/bin/env bash
# secret-guard.sh — PreToolUse hook (matcher: Bash)
#
# Blocks Bash commands that would put secrets into git:
#   - `git add` / `git stage` of .env, .env.* (except *.example), .dev.vars,
#     .dev.vars.*, *.pem, *.key, *.p12, credentials.json
#   - any `git add -f` / `git add --force` (it bypasses .gitignore)
#   - `git commit -a` / `-am` / `--all` while such a file is already tracked
#
# Contract: JSON on stdin (see lib/hook-input.sh). Exit 2 blocks the tool call
# and the one-line stderr message is shown to Claude. Exit 0 allows it.
#
# Fails open: empty or malformed stdin, a non-Bash tool, or any unexpected
# runtime error exits 0. The only blocking exit is the explicit `exit 2`.
#
# Known limits (.gitignore is the real backstop):
#   - `bash -c "git add .env"` and `eval` bodies are not inspected.
#   - `git add .` / `git add -A` are allowed; .gitignore must cover secrets.
#   - Only tracked files visible from the project root are checked for -a.

set -u
set -f
trap 'exit 0' ERR

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$HOOK_DIR/../../scripts/lib/common.sh" ]]; then
  # shellcheck source=../../scripts/lib/common.sh
  source "$HOOK_DIR/../../scripts/lib/common.sh"
fi
# shellcheck source=lib/hook-input.sh
source "$HOOK_DIR/lib/hook-input.sh"
# shellcheck source=lib/bash-cmd.sh
source "$HOOK_DIR/lib/bash-cmd.sh"

hook_skip_requested && exit 0
[[ "$(hook_tool_name)" == "Bash" ]] || exit 0
CMD="$(hook_tool_command)"
[[ -n "$CMD" ]] || exit 0

# --- Secret file patterns ----------------------------------------------------

# is_secret_path <path> → 0 when the basename looks like a secret file.
is_secret_path() {
  local base="${1##*/}"
  case "$base" in
    .env.example|.env.*.example|.dev.vars.example|.dev.vars.*.example) return 1 ;;
    .env|.env.*|.dev.vars|.dev.vars.*|*.pem|*.key|*.p12|credentials.json) return 0 ;;
  esac
  return 1
}

# tracked_secret → prints the first tracked secret file (if any).
tracked_secret() {
  local f
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if is_secret_path "$f"; then
      printf '%s' "$f"
      return 0
    fi
  done < <(git ls-files -- '.env' '.env.*' '*/.env' '*/.env.*' '.dev.vars*' '*/.dev.vars*' \
                            '*.pem' '*.key' '*.p12' 'credentials.json' '*/credentials.json' 2>/dev/null || true)
  return 0
}

# --- Per-subcommand checks (read ARGS, set BLOCK) ----------------------------

BLOCK=""
ARGS=()

check_add() {
  local tok dd=0
  for tok in ${ARGS[@]+"${ARGS[@]}"}; do
    if (( dd == 0 )); then
      case "$tok" in
        --) dd=1; continue ;;
        -f|--force) BLOCK="a forced add ($tok), which bypasses .gitignore"; return 0 ;;
        --*) continue ;;
        -*f*) BLOCK="a forced add ($tok), which bypasses .gitignore"; return 0 ;;
        -*) continue ;;
      esac
    fi
    if is_secret_path "$tok"; then
      BLOCK="a secret file ($tok)"
      return 0
    fi
  done
  return 0
}

check_commit() {
  local tok all=0 tracked=""
  local cluster_re='^-[A-Za-z]+$'
  for tok in ${ARGS[@]+"${ARGS[@]}"}; do
    case "$tok" in
      --) break ;;
      -a|--all) all=1; break ;;
      --*) continue ;;
    esac
    if [[ "$tok" =~ $cluster_re && "$tok" == *a* ]]; then
      all=1
      break
    fi
  done
  (( all )) || return 0
  tracked="$(tracked_secret)"
  if [[ -n "$tracked" ]]; then
    BLOCK="every tracked change via commit -a while a secret file is tracked ($tracked); untrack it first with: git rm --cached $tracked"
  fi
  return 0
}

# --- Walk every simple command in the call -----------------------------------

hook_split_commands "$CMD"
for seg in ${HOOK_SEGMENTS[@]+"${HOOK_SEGMENTS[@]}"}; do
  [[ -n "${seg//[[:space:]]/}" ]] || continue
  hook_tokenize "$seg"
  hook_strip_wrappers
  argv=(${HOOK_ARGV[@]+"${HOOK_ARGV[@]}"})
  (( ${#argv[@]} >= 2 )) || continue
  [[ "${argv[0]##*/}" == "git" ]] || continue

  # Skip git's global options to find the subcommand (git -C api add .env).
  idx=1
  while (( idx < ${#argv[@]} )); do
    case "${argv[idx]}" in
      -C|-c|--git-dir|--work-tree|--namespace|--exec-path) idx=$((idx + 2)) ;;
      -*) idx=$((idx + 1)) ;;
      *) break ;;
    esac
  done
  (( idx < ${#argv[@]} )) || continue

  sub="${argv[idx]}"
  ARGS=(${argv[@]+"${argv[@]:idx+1}"})
  case "$sub" in
    add|stage) check_add ;;
    commit) check_commit ;;
  esac
  [[ -z "$BLOCK" ]] || break
done

if [[ -n "$BLOCK" ]]; then
  echo "[secret-guard] Blocked: this command would stage $BLOCK. Secrets stay out of git: keep them in .gitignore and commit a .env.example instead (bypass: run it yourself outside Claude Code, or launch Claude with NERVA_SKIP_HOOKS=1)." >&2
  exit 2
fi
exit 0
