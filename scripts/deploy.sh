#!/usr/bin/env bash
# Created: 2026-11-01
# Purpose: Deploy claude-mod's main to every machine: fast-forward the local
#   checkout the marketplace reads from, update every installed mod, then
#   reload idle sessions. Run by auto-claude after each merge
#   (.claude/auto-deploy.json) or by hand.
# Dependencies: git, claude, ssh (vela), tmux; scripts/reload-sessions.sh
# Test Status: run by hand on macOS, 2026-11-01
#
# Usage: scripts/deploy.sh [--host <ssh host>]...   (default hosts: vela)
set -euo pipefail

hosts=()
while [ $# -gt 0 ]; do
  case "$1" in
    --host) hosts+=("${2:?--host needs a value}"); shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ ${#hosts[@]} -eq 0 ] && hosts=(vela)

here=$(cd "$(dirname "$0")" && pwd)

# On one machine: the checkout the plugins are read from moves to origin/main,
# then each installed mod is updated. A checkout on another branch is refused,
# not switched: someone is working in it.
update_here() {
  local root=$HOME/dev/claude-mod
  local branch
  branch=$(git -C "$root" symbolic-ref --short HEAD)
  [ "$branch" = main ] || { echo "$(hostname): $root is on $branch, not main" >&2; return 1; }
  git -C "$root" fetch -q origin
  git -C "$root" merge -q --ff-only origin/main
  echo "$(hostname): $(git -C "$root" log --oneline -1)"
  claude plugin marketplace update claude-mod >/dev/null
  local installed
  installed=$(claude plugin list 2>/dev/null | sed -n 's/^ *❯ \([^@ ]*\)@claude-mod$/\1/p')
  for mod in $installed; do
    claude plugin update "$mod@claude-mod" 2>&1 | tail -1
  done
}

update_here
for host in "${hosts[@]}"; do
  ssh -o BatchMode=yes -o ConnectTimeout=15 "$host" "bash -s" <<<"$(declare -f update_here); update_here"
done

"$here/reload-sessions.sh" --apply
for host in "${hosts[@]}"; do
  "$here/reload-sessions.sh" --apply --host "$host"
done
