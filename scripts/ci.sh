#!/usr/bin/env bash
# Created: 2026-10-27
# Purpose: The repository's CI, run the same way locally and in GitHub Actions:
#   `claude plugin validate` for the marketplace and every mod, `claude plugin
#   test` for every mod, tsc for each mod with a tsconfig.json, then
#   `bun scripts/sync-shared.ts --check` for the copies generated from shared/.
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

# Type check, for each mod with a tsconfig.json. Its base config lives in the
# generated .claude-plugin/types (gitignored, written by `claude plugin init`),
# so a checkout without it (GitHub Actions) says it skipped instead of failing.
# bun strips types without checking them, so `claude plugin test` alone never
# sees a type error.
for mod in "${mods[@]}"; do
  [ -f "$mod/tsconfig.json" ] || continue
  if [ ! -f "$mod/.claude-plugin/types/tsconfig.json" ]; then
    echo "== $mod: tsc skipped (no generated .claude-plugin/types)"
    continue
  fi
  echo "== $mod: tsc"
  out=$(cd "$mod" && bun x --package typescript@5.6.3 tsc --noEmit -p . 2>&1)
  errs=$(printf '%s\n' "$out" | grep -c 'error TS')
  if [ "$errs" -ne 0 ]; then
    printf '%s\n' "$out" | grep 'error TS' | head -20
    failed+=("$mod tsc ($errs errors)")
  fi
done

echo "== shared: sync-shared --check"
if ! out=$(bun scripts/sync-shared.ts --check 2>&1); then
  printf '%s\n' "$out"
  failed+=("sync-shared (a copy drifted from shared/)")
fi

if [ ${#failed[@]} -gt 0 ]; then
  echo "ci: FAILED: ${failed[*]}" >&2
  exit 1
fi
echo "ci: marketplace and ${#mods[@]} mods passed"
