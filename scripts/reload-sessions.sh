#!/usr/bin/env bash
# Created: 2026-10-29
# Purpose: Apply updated plugins to every running Claude Code session at once,
#   here or on another machine: each idle session in tmux gets /reload-plugins.
#   Busy sessions, sessions waiting on the person and sessions outside tmux are
#   listed and left alone; run it again once they are idle.
# Dependencies: tmux, python3, ps; ssh for --host
# Test Status: run by hand on macOS and Linux (vela), 2026-10-29
#
# Usage: scripts/reload-sessions.sh [--apply] [--host <ssh host>]
#   Without --apply it only lists what it would do.
set -uo pipefail

apply=0
host=''
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) apply=1 ;;
    --host) host=${2:?--host needs a value}; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$host" ]; then
  args=()
  [ "$apply" = 1 ] && args+=(--apply)
  exec ssh -o BatchMode=yes "$host" 'bash -s --' "${args[@]}" < "$0"
fi

command -v tmux >/dev/null || { echo "no tmux on $(hostname)" >&2; exit 1; }

# pane id for each pane's root process.
declare -A pane_of
while read -r id pid; do pane_of[$pid]=$id; done < <(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null)

# The pane a process runs in: the nearest ancestor that is a pane's root.
pane_for() {
  local pid=$1
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    [ -n "${pane_of[$pid]:-}" ] && { echo "${pane_of[$pid]}"; return; }
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  done
}

reloaded=0
skipped=0
for f in "$HOME"/.claude/sessions/[0-9]*.json; do
  [ -e "$f" ] || continue
  pid=$(basename "$f" .json)
  kill -0 "$pid" 2>/dev/null || continue
  read -r name status < <(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("name") or d.get("sessionId","?"), d.get("status","?"))' "$f")
  pane=$(pane_for "$pid")
  if [ -z "$pane" ]; then
    echo "skip  $name: not in tmux"; skipped=$((skipped + 1)); continue
  fi
  if [ "$status" != idle ]; then
    echo "skip  $name ($pane): $status"; skipped=$((skipped + 1)); continue
  fi
  if [ "$apply" = 1 ]; then
    tmux send-keys -t "$pane" C-u
    tmux send-keys -t "$pane" '/reload-plugins' Enter
    echo "sent  $name ($pane)"
  else
    echo "would $name ($pane)"
  fi
  reloaded=$((reloaded + 1))
done

echo "$(hostname): $reloaded idle session(s)$([ "$apply" = 1 ] && echo ' reloaded' || echo ' to reload'), $skipped skipped"
