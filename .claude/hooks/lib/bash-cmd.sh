#!/usr/bin/env bash
# bash-cmd.sh — small shell-command parser for the PreToolUse guards
#
# The guards need to know which *simple commands* a Bash tool call contains
# and what their words are, without being fooled by quoted strings, heredoc
# bodies, or comments. This is a pragmatic single-pass parser, not a full
# bash grammar; the known limits are listed at the bottom.
#
# Source after hook-input.sh:
#
#   source "$HOOK_DIR/lib/bash-cmd.sh"
#
# Provides:
#
#   hook_split_commands <string>
#       Fills HOOK_SEGMENTS with one entry per simple command. Splits on
#       newline ; | || && & ( ) and backticks (outside quotes), drops
#       comments, and skips heredoc bodies (<<EOF ... EOF, <<-'EOF', <<"EOF").
#       Redirections such as 2>&1 and &> are kept inside their segment.
#       Segments may be empty; callers skip those.
#
#   hook_tokenize <segment>
#       Fills HOOK_TOKENS with the words of one segment. Single and double
#       quotes and backslash escapes are honoured and removed.
#
#   hook_strip_wrappers
#       Reads HOOK_TOKENS and fills HOOK_ARGV with the same words minus leading
#       VAR=value assignments and launcher words (sudo, env, command, time,
#       nohup, exec, builtin, if/then/else/while/until/do, { } !). After this,
#       HOOK_ARGV[0] is the program being run.
#
# Bash 3.2 compatible (macOS /bin/bash). All functions return 0.
#
# Limits (documented in docs/onboarding/hooks.md):
#   - `bash -c "..."`, `eval "..."`, and `sh script.sh` bodies are not parsed.
#   - $'...' ANSI-C strings and ${VAR} expansions are treated as plain text.
#   - Only one heredoc per line is recognised.

if [[ -n "${__NERVA_BASH_CMD_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
__NERVA_BASH_CMD_LOADED=1

HOOK_SEGMENTS=()
HOOK_TOKENS=()
HOOK_ARGV=()

hook_split_commands() {
  local s="${1-}"
  local n=${#s}
  local i=0 j=0 ln=0
  local c="" nxt="" prev="" seg="" q="" hd="" w="" qq="" line="" t=""
  HOOK_SEGMENTS=()

  while (( i < n )); do
    c="${s:i:1}"

    # Inside quotes: copy verbatim until the matching quote.
    if [[ -n "$q" ]]; then
      seg+="$c"
      if [[ "$c" == "$q" ]]; then
        q=""
      elif [[ "$q" == '"' && "$c" == '\' ]]; then
        i=$((i + 1))
        seg+="${s:i:1}"
      fi
      i=$((i + 1))
      continue
    fi

    nxt="${s:i+1:1}"
    case "$c" in
      \'|\")
        q="$c"
        seg+="$c"
        ;;
      \\)
        # Backslash escape (including backslash-newline continuation).
        seg+="$c$nxt"
        i=$((i + 1))
        ;;
      '#')
        # A comment only starts at a word boundary.
        if [[ -z "$seg" || "$seg" == *[[:space:]] ]]; then
          while (( i < n )) && [[ "${s:i:1}" != $'\n' ]]; do
            i=$((i + 1))
          done
          continue
        fi
        seg+="$c"
        ;;
      '<')
        if [[ "$nxt" == '<' && "${s:i+2:1}" != '<' ]]; then
          # Heredoc operator: read the delimiter word, remember it, and skip
          # the body once the current line ends.
          j=$((i + 2))
          w=""
          if [[ "${s:j:1}" == '-' ]]; then
            j=$((j + 1))
          fi
          while [[ "${s:j:1}" == ' ' || "${s:j:1}" == $'\t' ]]; do
            j=$((j + 1))
          done
          qq="${s:j:1}"
          if [[ "$qq" == "'" || "$qq" == '"' ]]; then
            j=$((j + 1))
            while (( j < n )) && [[ "${s:j:1}" != "$qq" ]]; do
              w+="${s:j:1}"
              j=$((j + 1))
            done
            j=$((j + 1))
          else
            while (( j < n )) && [[ "${s:j:1}" == [A-Za-z0-9_] ]]; do
              w+="${s:j:1}"
              j=$((j + 1))
            done
          fi
          hd="$w"
          seg+="${s:i:j-i}"
          i=$j
          continue
        fi
        seg+="$c"
        ;;
      $'\n')
        HOOK_SEGMENTS+=("$seg")
        seg=""
        if [[ -n "$hd" ]]; then
          # Skip heredoc body lines up to and including the terminator.
          i=$((i + 1))
          while (( i < n )); do
            line="${s:i}"
            line="${line%%$'\n'*}"
            ln=${#line}
            i=$((i + ln + 1))
            t="$line"
            while [[ "$t" == $'\t'* ]]; do
              t="${t:1}"
            done
            if [[ "$t" == "$hd" ]]; then
              break
            fi
          done
          hd=""
          continue
        fi
        ;;
      ';'|'('|')'|'`')
        HOOK_SEGMENTS+=("$seg")
        seg=""
        ;;
      '|')
        HOOK_SEGMENTS+=("$seg")
        seg=""
        if [[ "$nxt" == '|' ]]; then
          i=$((i + 1))
        fi
        ;;
      '&')
        if [[ "$nxt" == '&' ]]; then
          HOOK_SEGMENTS+=("$seg")
          seg=""
          i=$((i + 1))
        elif [[ "$nxt" == '>' ]]; then
          seg+="$c"                       # &> redirect
        else
          prev=""
          if (( i > 0 )); then
            prev="${s:i-1:1}"
          fi
          if [[ "$prev" == '>' || "$prev" == '<' ]]; then
            seg+="$c"                     # 2>&1, <&0
          else
            HOOK_SEGMENTS+=("$seg")       # background job separator
            seg=""
          fi
        fi
        ;;
      *)
        seg+="$c"
        ;;
    esac
    i=$((i + 1))
  done

  if [[ -n "$seg" ]]; then
    HOOK_SEGMENTS+=("$seg")
  fi
  return 0
}

hook_tokenize() {
  local s="${1-}"
  local n=${#s}
  local i=0 intok=0
  local c="" tok="" q=""
  HOOK_TOKENS=()

  while (( i < n )); do
    c="${s:i:1}"
    if [[ -n "$q" ]]; then
      if [[ "$c" == "$q" ]]; then
        q=""
      elif [[ "$q" == '"' && "$c" == '\' ]]; then
        i=$((i + 1))
        tok+="${s:i:1}"
      else
        tok+="$c"
      fi
      i=$((i + 1))
      continue
    fi
    case "$c" in
      \'|\")
        q="$c"
        intok=1
        ;;
      \\)
        i=$((i + 1))
        tok+="${s:i:1}"
        intok=1
        ;;
      ' '|$'\t'|$'\n'|$'\r')
        if (( intok )); then
          HOOK_TOKENS+=("$tok")
          tok=""
          intok=0
        fi
        ;;
      *)
        tok+="$c"
        intok=1
        ;;
    esac
    i=$((i + 1))
  done

  if (( intok )); then
    HOOK_TOKENS+=("$tok")
  fi
  return 0
}

hook_strip_wrappers() {
  local -a rest
  rest=(${HOOK_TOKENS[@]+"${HOOK_TOKENS[@]}"})
  while (( ${#rest[@]} > 0 )); do
    case "${rest[0]}" in
      sudo|command|env|time|nohup|exec|builtin|if|then|else|elif|while|until|do|\{|\}|\!) ;;
      [A-Za-z_]*=*) ;;
      *) break ;;
    esac
    rest=(${rest[@]+"${rest[@]:1}"})
  done
  HOOK_ARGV=(${rest[@]+"${rest[@]}"})
  return 0
}
