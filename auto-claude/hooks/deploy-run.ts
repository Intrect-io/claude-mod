// Running a deploy: a fresh detached checkout of what was merged, the scan,
// the command, then its smoke check. What is deployed is decided in deploy.ts.

import type { EngineInterface } from 'claude-code'

import type { AutoRecord } from '../types'
import { findingsOf, scriptsOf } from './deploy'
import type { DeploySpec } from './deploy'
import { fetchRemote, out, refOf, run, tell } from './io'

// $.process.run allows ten minutes at most.
const SCAN_TIMEOUT_MS = 10 * 60_000

// `scanKnown`: the scan output now known to predate the run, when a scan changed
// it; the caller keeps it on the record.
export type DeployResult = ({ kind: 'ok' } | { kind: 'skipped'; why: string } | { kind: 'failed'; why: string }) & { scanKnown?: string[] }

// Deploys after a merge. A deploy whose script has not landed yet waits; one
// that fails (the scan, the command or the smoke check) becomes a milestone that
// repairs it, built from the default branch; MAX_DEPLOY_FAILS in a row stop the run.
// Deploys what the default branch now holds, from a fresh detached checkout of
// it: the scan first, the command, then its smoke check.
export async function deployMerged($: EngineInterface, r: AutoRecord, spec: DeploySpec): Promise<DeployResult> {
  const dir = `${r.root}/worktrees/auto-deploy`
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  await fetchRemote($, r, r.root)
  const made = await run($, ['git', '-C', r.root, 'worktree', 'add', '--detach', dir, refOf(r)], r.root)
  if (made.exitCode !== 0) return { kind: 'failed', why: `no checkout of ${refOf(r)}: ${out(made)}` }
  try {
    for (const script of scriptsOf(spec.command)) {
      if ((await run($, ['test', '-e', script], dir, 15_000)).exitCode !== 0) return { kind: 'skipped', why: `${script} is not in ${r.defaultBranch} yet` }
    }
    let known: string[] | undefined
    const withKnown = (result: DeployResult): DeployResult => (known === undefined ? result : { ...result, scanKnown: known })
    if (spec.scan !== undefined) {
      const gate = await scanGate($, r, dir, spec.scan)
      if (gate.known !== undefined) known = gate.known
      if (gate.blocked !== undefined) return withKnown({ kind: 'failed', why: gate.blocked })
    }
    const ran = await run($, ['bash', '-lc', spec.command], dir, spec.timeoutMs)
    if (ran.exitCode !== 0) return withKnown({ kind: 'failed', why: `\`${spec.command}\` exited ${ran.exitCode}: ${out(ran)}` })
    if (spec.smoke !== undefined) {
      const smoked = await run($, ['bash', '-lc', spec.smoke], dir, 300_000)
      if (smoked.exitCode !== 0) return withKnown({ kind: 'failed', why: `the smoke check \`${spec.smoke}\` exited ${smoked.exitCode}: ${out(smoked)}` })
    }
    return withKnown({ kind: 'ok' })
  } finally {
    await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  }
}

// The scan before a deploy (a local tool the plan names: bandit, cargo audit,
// gitleaks, …). Exit 0 passes. A failure whose output holds lines the run
// brought in blocks it; a failure printing only what was already there before
// the run is told, not blocking: it was live before this run deployed anything,
// and blocking on such results stopped whole runs (intrect-platform,
// 2026-11-17: 48 old results; kyte-portal deferred 112 h). "Before" is the
// record's known set (the last scan that passed or was only old), else the same
// scan of the commit the run started from (baseSha).
export async function scanGate($: EngineInterface, r: AutoRecord, dir: string, scan: string): Promise<{ blocked?: string; known?: string[] }> {
  const head = await run($, ['bash', '-lc', scan], dir, SCAN_TIMEOUT_MS)
  if (head.exitCode === 0) return { known: [] }
  if (head.exitCode < 0) return { blocked: `the scan \`${scan}\` did not finish: ${out(head)}` }
  const now = findingsOf(`${head.stdout}\n${head.stderr}`)
  let before = r.scanKnown
  let since = 'the last deploy the scan passed'
  if (before === undefined) {
    const base = r.baseSha ?? `${refOf(r)}~1`
    since = `${base.slice(0, 12)}, where the run started`
    const old = await scanAt($, r, base, scan)
    if ('error' in old) return { blocked: `the scan \`${scan}\` exited ${head.exitCode}: ${out(head)}. ${base} could not be scanned to tell output from before the run apart: ${old.error}` }
    before = old.lines
  }
  const known = new Set(before)
  const fresh = now.filter(l => !known.has(l))
  if (fresh.length > 0) {
    return { blocked: `the scan \`${scan}\` exited ${head.exitCode} and printed ${fresh.length} line(s) it did not print before the run (${since}): ${fresh.slice(0, 5).join(' | ').slice(0, 600)}`, known: before }
  }
  // Told when the set changes, not on every deploy.
  if (r.scanKnown?.length !== now.length) await tell($, r, `the scan \`${scan}\` exited ${head.exitCode} with only output from before the run (${since}); it does not block`)
  return { known: now }
}

// The same scan of an older commit, in a checkout of its own.
async function scanAt($: EngineInterface, r: AutoRecord, ref: string, scan: string): Promise<{ lines: string[] } | { error: string }> {
  const dir = `${r.root}/worktrees/auto-scan-base`
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  const made = await run($, ['git', '-C', r.root, 'worktree', 'add', '--detach', dir, ref], r.root)
  if (made.exitCode !== 0) return { error: `no checkout of ${ref}: ${out(made)}` }
  try {
    const ran = await run($, ['bash', '-lc', scan], dir, SCAN_TIMEOUT_MS)
    if (ran.exitCode < 0) return { error: `the scan did not finish: ${out(ran)}` }
    return { lines: ran.exitCode === 0 ? [] : findingsOf(`${ran.stdout}\n${ran.stderr}`) }
  } finally {
    await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  }
}
