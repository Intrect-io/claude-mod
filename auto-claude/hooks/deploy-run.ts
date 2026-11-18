// Running a deploy: a fresh detached checkout of what was merged, CodeQL,
// the command, then its smoke check. What is deployed is decided in deploy.ts.

import type { EngineInterface } from 'claude-code'

import type { AutoRecord } from '../types'
import { codeqlSuite, countSarif, scriptsOf } from './deploy'
import type { DeploySpec, SarifCount } from './deploy'
import { fetchRemote, out, readText, refOf, run, tell } from './io'

// `codeqlKnown`: the error-level CodeQL results now known to predate the run, by
// language, when a scan changed them; the caller keeps them on the record.
export type DeployResult = ({ kind: 'ok' } | { kind: 'skipped'; why: string } | { kind: 'failed'; why: string }) & { codeqlKnown?: Record<string, string[]> }

// Deploys after a merge. A deploy whose script has not landed yet waits; one
// that fails (the command, CodeQL or the smoke check) becomes a milestone that
// repairs it, built from the default branch; MAX_DEPLOY_FAILS in a row stop the run.
// Deploys what the default branch now holds, from a fresh detached checkout of
// it: CodeQL first, the command, then its smoke check.
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
    let known: Record<string, string[]> | undefined
    const withKnown = (result: DeployResult): DeployResult => (known === undefined ? result : { ...result, codeqlKnown: known })
    for (const language of spec.codeql) {
      const gate = await codeqlGate($, r, dir, language)
      if (gate.known !== undefined) known = { ...(known ?? r.codeqlKnown ?? {}), [language]: gate.known }
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

// CodeQL before a deploy (CLAUDE.md §5). An error-level result the run brought
// in blocks it; one that was already there before the run is told, not
// blocking: it was live before this run deployed anything, and blocking on it
// stopped whole runs (intrect-platform, 2026-11-17: 48 old results; kyte-portal
// deferred 112 h). "Before" is the record's known set (the last scan that
// passed), else a scan of the commit the run started from (baseSha).
// The databases and SARIF stay outside the repository, in $TMPDIR.
export async function codeqlGate($: EngineInterface, r: AutoRecord, dir: string, language: string): Promise<{ blocked?: string; known?: string[] }> {
  const head = await scan($, r, dir, language, '')
  if ('error' in head) return { blocked: head.error }
  const c = head.count
  if (c.errors === 0) {
    if (c.warnings > 0) await tell($, r, `CodeQL ${language}: ${c.warnings} warning(s), no errors; SARIF at ${head.sarif}`)
    return { known: [] }
  }
  let before = r.codeqlKnown?.[language]
  let since = 'the last deploy CodeQL passed'
  if (before === undefined) {
    const base = r.baseSha ?? `${refOf(r)}~1`
    since = `${base.slice(0, 12)}, where the run started`
    const old = await scanAt($, r, base, language)
    if ('error' in old) return { blocked: `CodeQL found ${c.errors} error-level result(s) in ${language} (${c.top.join('; ')}); SARIF at ${head.sarif}. ${base} could not be scanned to tell results from before the run apart: ${old.error}` }
    before = old.count.keys
  }
  const known = new Set(before)
  const fresh = c.keys.filter(k => !known.has(k))
  const told = `${c.errors - fresh.length} error-level result(s) were there before (${since}) and do not block`
  if (fresh.length > 0) {
    return { blocked: `CodeQL found ${fresh.length} new error-level result(s) in ${language} (${fresh.slice(0, 5).map(k => c.labels[k]).join('; ')}); ${told}; SARIF at ${head.sarif}`, known: before }
  }
  // Told when the set changes, not on every deploy.
  if (r.codeqlKnown?.[language]?.length !== c.keys.length) await tell($, r, `CodeQL ${language}: ${told}: ${c.top.join('; ')}; SARIF at ${head.sarif}`)
  return { known: c.keys }
}

async function scan($: EngineInterface, r: AutoRecord, dir: string, language: string, suffix: string): Promise<{ count: SarifCount; sarif: string } | { error: string }> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  const name = `${r.root.split('/').pop() ?? 'repo'}-${language}${suffix}`
  const db = `${tmp}/auto-claude-codeql-${name}`
  const sarif = `${tmp}/auto-claude-codeql-${name}.sarif`
  const created = await run($, ['codeql', 'database', 'create', db, `--language=${language}`, '--source-root', dir, '--overwrite'], dir, 600_000)
  if (created.exitCode !== 0) return { error: `CodeQL could not build a ${language} database: ${out(created)}` }
  const analyzed = await run($, ['codeql', 'database', 'analyze', db, codeqlSuite(language), '--format=sarif-latest', `--output=${sarif}`], dir, 600_000)
  if (analyzed.exitCode !== 0) return { error: `CodeQL ${language} analysis failed: ${out(analyzed)}` }
  const count = countSarif((await readText($, sarif)) ?? '')
  if (count === undefined) return { error: `CodeQL wrote no readable SARIF at ${sarif}` }
  return { count, sarif }
}

// The same scan of an older commit, in a checkout of its own.
async function scanAt($: EngineInterface, r: AutoRecord, ref: string, language: string): Promise<{ count: SarifCount; sarif: string } | { error: string }> {
  const dir = `${r.root}/worktrees/auto-codeql-base`
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  const made = await run($, ['git', '-C', r.root, 'worktree', 'add', '--detach', dir, ref], r.root)
  if (made.exitCode !== 0) return { error: `no checkout of ${ref}: ${out(made)}` }
  try {
    return await scan($, r, dir, language, '-base')
  } finally {
    await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  }
}
