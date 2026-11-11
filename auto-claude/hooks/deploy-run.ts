// Running a deploy: a fresh detached checkout of what was merged, CodeQL,
// the command, then its smoke check. What is deployed is decided in deploy.ts.

import type { EngineInterface } from 'claude-code'

import type { AutoRecord } from '../types'
import { codeqlSuite, countSarif, scriptsOf } from './deploy'
import type { DeploySpec } from './deploy'
import { fetchRemote, out, readText, refOf, run, tell } from './io'

export type DeployResult = { kind: 'ok' } | { kind: 'skipped'; why: string } | { kind: 'failed'; why: string }

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
    for (const language of spec.codeql) {
      const blocked = await codeqlGate($, r, dir, language)
      if (blocked !== undefined) return { kind: 'failed', why: blocked }
    }
    const ran = await run($, ['bash', '-lc', spec.command], dir, spec.timeoutMs)
    if (ran.exitCode !== 0) return { kind: 'failed', why: `\`${spec.command}\` exited ${ran.exitCode}: ${out(ran)}` }
    if (spec.smoke !== undefined) {
      const smoked = await run($, ['bash', '-lc', spec.smoke], dir, 300_000)
      if (smoked.exitCode !== 0) return { kind: 'failed', why: `the smoke check \`${spec.smoke}\` exited ${smoked.exitCode}: ${out(smoked)}` }
    }
    return { kind: 'ok' }
  } finally {
    await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  }
}

// CodeQL before a deploy (CLAUDE.md §5): any error-level result blocks it.
// The database and SARIF stay outside the repository, in $TMPDIR.
export async function codeqlGate($: EngineInterface, r: AutoRecord, dir: string, language: string): Promise<string | undefined> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  const name = `${r.root.split('/').pop() ?? 'repo'}-${language}`
  const db = `${tmp}/auto-claude-codeql-${name}`
  const sarif = `${tmp}/auto-claude-codeql-${name}.sarif`
  const created = await run($, ['codeql', 'database', 'create', db, `--language=${language}`, '--source-root', dir, '--overwrite'], dir, 600_000)
  if (created.exitCode !== 0) return `CodeQL could not build a ${language} database: ${out(created)}`
  const analyzed = await run($, ['codeql', 'database', 'analyze', db, codeqlSuite(language), '--format=sarif-latest', `--output=${sarif}`], dir, 600_000)
  if (analyzed.exitCode !== 0) return `CodeQL ${language} analysis failed: ${out(analyzed)}`
  const counted = countSarif((await readText($, sarif)) ?? '')
  if (counted === undefined) return `CodeQL wrote no readable SARIF at ${sarif}`
  if (counted.errors > 0) return `CodeQL found ${counted.errors} error-level result(s) in ${language} (${counted.top.join('; ')}); SARIF at ${sarif}`
  if (counted.warnings > 0) await tell($, r, `CodeQL ${language}: ${counted.warnings} warning(s), no errors; SARIF at ${sarif}`)
  return undefined
}
