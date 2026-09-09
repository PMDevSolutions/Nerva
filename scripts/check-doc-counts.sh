#!/usr/bin/env bash
# check-doc-counts.sh — Flag documentation drift in agent/skill/script/command counts.
#
# Counts the real entries on disk:
#   agents    → *.md files directly in .claude/agents/ (excluding README)
#   skills    → subdirectories of .claude/skills/ that contain a SKILL.md
#   scripts   → *.sh / *.js files directly in scripts/ (lib/ and __tests__/ excluded)
#   commands  → *.md files directly in .claude/commands/
#
# Then scans the live Markdown docs for any "N agents" / "N skills" /
# "N scripts" / "N commands" claim and fails if a claim disagrees with the
# on-disk count. Historical, generated, and sample records (CHANGELOG.md,
# RELEASE_NOTES.md, docs/plans/, examples/) are intentionally excluded — they
# describe a past release or a separate project and must not be rewritten.
#
# Usage:
#   ./scripts/check-doc-counts.sh                # human-readable report, exit 1 on drift
#   ./scripts/check-doc-counts.sh --json         # machine-readable output
#   ./scripts/check-doc-counts.sh --root <dir>   # check a different project tree
#   ./scripts/check-doc-counts.sh --help         # this text
#
# Exit codes: 0 = in sync, 1 = drift detected, 2 = usage/IO error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

JSON=0
ROOT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1 ;;
    --root)
      if [[ -z "${2:-}" ]]; then
        say_err "--root requires a directory argument"
        exit 2
      fi
      ROOT="$2"
      shift
      ;;
    -h|--help)
      # Print the leading comment block (skip shebang, stop at first code line).
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *) say_err "Unknown argument: $1 (try --help)"; exit 2 ;;
  esac
  shift
done

if [[ -z "$ROOT" ]]; then
  ROOT="$(common_project_root)"
fi
if [[ ! -d "$ROOT" ]]; then
  say_err "Not a directory: $ROOT"
  exit 2
fi
cd "$ROOT"

# --- Count entries on disk ------------------------------------------------

AGENT_DIR=".claude/agents"
SKILL_DIR=".claude/skills"
SCRIPTS_DIR="scripts"
COMMAND_DIR=".claude/commands"

agent_count=0
if [[ -d "$AGENT_DIR" ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    case "$(basename "$f" | tr '[:upper:]' '[:lower:]')" in
      readme.md) continue ;;
    esac
    agent_count=$((agent_count + 1))
  done < <(find "$AGENT_DIR" -maxdepth 1 -type f -name '*.md')
fi

skill_count=0
if [[ -d "$SKILL_DIR" ]]; then
  while IFS= read -r d; do
    [[ -z "$d" ]] && continue
    [[ -f "$d/SKILL.md" ]] && skill_count=$((skill_count + 1))
  done < <(find "$SKILL_DIR" -mindepth 1 -maxdepth 1 -type d)
fi

script_count=0
if [[ -d "$SCRIPTS_DIR" ]]; then
  script_count=$(find "$SCRIPTS_DIR" -maxdepth 1 -type f \( -name '*.sh' -o -name '*.js' \) | wc -l | tr -d ' ')
fi

command_count=0
if [[ -d "$COMMAND_DIR" ]]; then
  command_count=$(find "$COMMAND_DIR" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')
fi

# --- Scan docs for count claims -------------------------------------------
#
# A "claim" is a number adjacent to one of the PLURAL nouns agents / skills /
# scripts / commands. Count statements are always plural, so requiring the
# plural form avoids matching incidental phrases like "Phase 1 skill". Three
# forms are recognized:
#   A: "<N> [adj]{0,3} agents"        e.g. "24 specialized agents", "12 skills"
#   B: "Agents (<N> Total)"           e.g. "Skills (12 Total)", "scripts (9 total)"
#   C: "Total Agents:** <N>"          e.g. "**Total Skills:** 12"
#
# Form A requires the number to start a word (preceded by start-of-line or a
# non-alphanumeric character) so that "k6 scripts" is not read as "6 scripts".
# Table cells like "| Engineering | 6 |" never match: there is no noun.
#
# Each match is reduced to (noun, number) and compared against the disk count.

NOUNS='(agents|skills|scripts|commands)'
COMBINED="(^|[^A-Za-z0-9_])[0-9]+( +[a-z][a-z./+-]*){0,3} +${NOUNS}"
COMBINED+="|${NOUNS} *\\(?[0-9]+ +total"
COMBINED+="|total +${NOUNS}[^0-9]{0,8}[0-9]+"

is_excluded_path() {
  case "$1" in
    docs/plans/*|examples/*|*/node_modules/*|node_modules/*|.git/*) return 0 ;;
  esac
  case "$(basename "$1")" in
    CHANGELOG.md|RELEASE_NOTES.md) return 0 ;;
  esac
  return 1
}

# Count the docs in scope for the report.
DOC_COUNT=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  is_excluded_path "${f#./}" && continue
  DOC_COUNT=$((DOC_COUNT + 1))
done < <(find . \( -name .git -o -name node_modules \) -prune -o -type f -name '*.md' -print)

# Run the combined matcher once recursively (a single grep process) for speed.
# grep -rIno output is "path:lineno:matched-text". Each match contains exactly
# one number in every form, so stripping non-digits yields the claimed count.
# Field separators: file, line, noun, claimed, actual, text (tab-delimited).
RAW_DRIFT=""
while IFS= read -r match; do
  [[ -z "$match" ]] && continue
  file="${match%%:*}"; rest="${match#*:}"
  lineno="${rest%%:*}"; text="${rest#*:}"
  file="${file#./}"
  is_excluded_path "$file" && continue
  # Form A's leading boundary character (space, quote, asterisk, ...) is part
  # of the match; drop it so identical claims on one line de-duplicate.
  text="${text#[^A-Za-z0-9]}"
  num="${text//[!0-9]/}"
  [[ -z "$num" ]] && continue
  # nocasematch keeps this a pure-bash comparison (no per-match subprocess).
  shopt -s nocasematch
  case "$text" in
    *agents*)   noun="agents";   expected="$agent_count" ;;
    *skills*)   noun="skills";   expected="$skill_count" ;;
    *scripts*)  noun="scripts";  expected="$script_count" ;;
    *commands*) noun="commands"; expected="$command_count" ;;
    *) shopt -u nocasematch; continue ;;
  esac
  shopt -u nocasematch
  if [[ "$num" != "$expected" ]]; then
    squished="$(printf '%s' "$text" | tr '\t' ' ' | sed -e 's/  */ /g' -e 's/^ *//' -e 's/ *$//')"
    RAW_DRIFT+="${file}	${lineno}	${noun}	${num}	${expected}	${squished}"$'\n'
  fi
done < <(grep -riInoE "$COMBINED" \
  --include='*.md' \
  --exclude='CHANGELOG.md' \
  --exclude='RELEASE_NOTES.md' \
  --exclude-dir='.git' \
  --exclude-dir='node_modules' \
  . 2>/dev/null || true)

# A single claim can match more than one form; de-duplicate before counting.
DRIFT_FILE=()
DRIFT_LINE=()
DRIFT_NOUN=()
DRIFT_CLAIMED=()
DRIFT_ACTUAL=()
DRIFT_TEXT=()
if [[ -n "$RAW_DRIFT" ]]; then
  while IFS=$'\t' read -r d_file d_line d_noun d_claimed d_actual d_text; do
    [[ -z "$d_file" ]] && continue
    DRIFT_FILE+=("$d_file")
    DRIFT_LINE+=("$d_line")
    DRIFT_NOUN+=("$d_noun")
    DRIFT_CLAIMED+=("$d_claimed")
    DRIFT_ACTUAL+=("$d_actual")
    DRIFT_TEXT+=("$d_text")
  done < <(printf '%s' "$RAW_DRIFT" | sort -u)
fi
DRIFT=${#DRIFT_FILE[@]}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/\\r}"
  printf '%s' "$s"
}

# --- Report ---------------------------------------------------------------

if [[ "$JSON" -eq 1 ]]; then
  printf '{\n'
  printf '  "agents": %d,\n' "$agent_count"
  printf '  "skills": %d,\n' "$skill_count"
  printf '  "scripts": %d,\n' "$script_count"
  printf '  "commands": %d,\n' "$command_count"
  printf '  "docsScanned": %d,\n' "$DOC_COUNT"
  printf '  "drift": %d,\n' "$DRIFT"
  printf '  "violations": ['
  if [[ "$DRIFT" -gt 0 ]]; then
    printf '\n'
    i=0
    while [[ $i -lt $DRIFT ]]; do
      printf '    { "file": "%s", "line": %d, "noun": "%s", "claimed": %d, "actual": %d, "text": "%s" }' \
        "$(json_escape "${DRIFT_FILE[$i]}")" "${DRIFT_LINE[$i]}" "${DRIFT_NOUN[$i]}" \
        "${DRIFT_CLAIMED[$i]}" "${DRIFT_ACTUAL[$i]}" "$(json_escape "${DRIFT_TEXT[$i]}")"
      i=$((i + 1))
      [[ $i -lt $DRIFT ]] && printf ','
      printf '\n'
    done
    printf '  '
  fi
  printf ']\n}\n'
else
  say_banner "Documentation Count Check"
  echo ""
  say_step "On disk: ${agent_count} agents, ${skill_count} skills, ${script_count} scripts, ${command_count} commands"
  say_step "Scanned ${DOC_COUNT} Markdown files (CHANGELOG.md, RELEASE_NOTES.md, docs/plans/, examples/ excluded)"
  echo ""
  if [[ "$DRIFT" -eq 0 ]]; then
    say_pass "All agent/skill/script/command counts in docs match the entries on disk"
  else
    say_fail "${DRIFT} documentation count claim(s) drifted from disk:"
    i=0
    while [[ $i -lt $DRIFT ]]; do
      echo "    ${RED}${DRIFT_FILE[$i]}:${DRIFT_LINE[$i]}: claims ${DRIFT_CLAIMED[$i]} ${DRIFT_NOUN[$i]}, actual ${DRIFT_ACTUAL[$i]}${NC} -> \"${DRIFT_TEXT[$i]}\""
      i=$((i + 1))
    done
    echo ""
    echo "  Update the counts above, or re-run after adding/removing agents, skills, scripts, or commands."
  fi
fi

[[ "$DRIFT" -eq 0 ]] || exit 1
