#!/usr/bin/env bash
# Created: 2026-10-27
# Purpose: The repository's CI, run the same way locally and in GitHub Actions:
#   `claude plugin validate` for the marketplace and every mod, `claude plugin
#   test` for every mod, then fleet-hub's typecheck and `bun test`.
# Dependencies: claude (Claude Code CLI; no login needed), bun, perl
# Test Status: run by .github/workflows/ci.yml and by the auto-claude milestone checks
#
# `claude plugin test` exits 0 even when a test fails (measured with 2.1.311),
# so a mod passes only when its output reports at least one pass and 0 fail.
set -uo pipefail

cd "$(dirname "$0")/.."
failed=()

plain() { perl -pe 's/\e\[[0-9;]*[A-Za-z]//g'; }

mods=()
for dir in */; do
  dir=${dir%/}
  [ -f "$dir/.claude-plugin/plugin.json" ] && mods+=("$dir")
done
if [ ${#mods[@]} -eq 0 ]; then
  echo "ci: no mods found" >&2
  exit 1
fi

echo "== marketplace: validate"
if ! out=$(claude plugin validate . 2>&1); then
  printf '%s\n' "$out" | tail -20
  failed+=("marketplace validate")
fi

for mod in "${mods[@]}"; do
  echo "== $mod: validate"
  if ! out=$(claude plugin validate "$mod" 2>&1); then
    printf '%s\n' "$out" | tail -20
    failed+=("$mod validate")
  fi
  echo "== $mod: test"
  out=$(claude plugin test "$mod" 2>&1 | plain)
  passes=$(printf '%s\n' "$out" | sed -n 's/^ *\([0-9][0-9]*\) pass *$/\1/p' | tail -1)
  fails=$(printf '%s\n' "$out" | sed -n 's/^ *\([0-9][0-9]*\) fail *$/\1/p' | tail -1)
  printf '%s\n' "$out" | grep -E '^\(fail\)|^ *[0-9]+ (pass|fail) *$' || true
  if [ -z "$passes" ] || [ -z "$fails" ] || [ "$passes" -lt 1 ] || [ "$fails" -ne 0 ]; then
    printf '%s\n' "$out" | tail -30
    failed+=("$mod test (pass=${passes:-?} fail=${fails:-?})")
  fi
done

if [ -d fleet-hub ]; then
  echo "== fleet-hub: install, typecheck, test"
  if ! (cd fleet-hub && bun install --frozen-lockfile >/dev/null && bunx tsc -p . && bun test); then
    failed+=("fleet-hub")
  fi
fi

if [ ${#failed[@]} -gt 0 ]; then
  echo "ci: FAILED: ${failed[*]}" >&2
  exit 1
fi
echo "ci: marketplace, ${#mods[@]} mods and fleet-hub passed"
