// Deploying after each merge. What is deployed comes from .claude/auto-deploy.json
// (committed by the person, read once when the run starts) or, without it,
// from the plan's Deploy / Smoke check / Scan lines, fixed when
// auto_plan_ready accepts the plan; either way a milestone that edits it
// cannot change what this run executes. The driver runs it, never the model
// (its deploy and release commands stay refused), in a fresh checkout of what
// was merged.

import type { PlanDeploy } from './plan'

export type DeploySpec = {
  command: string
  // A local scan command run before each deploy (bandit, cargo audit, gitleaks, …); a non-zero exit with output the run brought in blocks the deploy. Unset: no scan.
  scan?: string
  timeoutMs: number
  // Run right after the deploy; it passes only when the deployed service works.
  smoke?: string
  source?: 'file' | 'plan'
}

export const DEPLOY_FILE = '.claude/auto-deploy.json'
const DEFAULT_TIMEOUT_MS = 10 * 60_000
// $.process.run allows ten minutes at most.
const MAX_TIMEOUT_MS = 10 * 60_000

// `{ "command": "bash scripts/deploy.sh", "scan": "bandit -q -r src", "timeoutSec": 600, "smoke": "curl -fsS https://x/health" }`
export function parseDeploy(text: string): DeploySpec | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: `${DEPLOY_FILE} is not JSON (${String(error).slice(0, 80)})` }
  }
  if (typeof value !== 'object' || value === null) return { error: `${DEPLOY_FILE} must be an object` }
  const v = value as { command?: unknown; codeql?: unknown; scan?: unknown; timeoutSec?: unknown; smoke?: unknown }
  if (typeof v.command !== 'string' || v.command.trim() === '') return { error: `${DEPLOY_FILE} needs a "command" string` }
  if (v.codeql !== undefined) return { error: `${DEPLOY_FILE} "codeql" is no longer run; name a local scan command in "scan" (for example "bandit -q -r src") or drop the key` }
  if (v.scan !== undefined && (typeof v.scan !== 'string' || v.scan.trim() === '')) return { error: `${DEPLOY_FILE} "scan" must be a command string` }
  const scan = typeof v.scan === 'string' ? v.scan.trim() : undefined
  if (v.timeoutSec !== undefined && (typeof v.timeoutSec !== 'number' || v.timeoutSec <= 0)) return { error: `${DEPLOY_FILE} "timeoutSec" must be a positive number` }
  const timeoutMs = v.timeoutSec === undefined ? DEFAULT_TIMEOUT_MS : Math.min(MAX_TIMEOUT_MS, v.timeoutSec * 1000)
  if (v.smoke !== undefined && (typeof v.smoke !== 'string' || v.smoke.trim() === '')) return { error: `${DEPLOY_FILE} "smoke" must be a command string` }
  const smoke = typeof v.smoke === 'string' ? v.smoke.trim() : undefined

  return { command: v.command.trim(), ...(scan !== undefined ? { scan } : {}), timeoutMs, ...(smoke !== undefined ? { smoke } : {}), source: 'file' }
}

export function specOfPlan(d: Extract<PlanDeploy, { kind: 'command' }>): DeploySpec {
  return { command: d.command, ...(d.scan !== undefined ? { scan: d.scan } : {}), timeoutMs: DEFAULT_TIMEOUT_MS, smoke: d.smoke, source: 'plan' }
}

// The files a deploy command names (`bash scripts/deploy.sh`, `./deploy`,
// `make -f ops/Makefile`): while one is missing from the merged default branch,
// the milestone that adds it has not landed yet, and the deploy waits instead
// of failing.
export function scriptsOf(command: string): string[] {
  return command
    .split(/\s+|&&|\|\||;/)
    .map(t => t.replace(/^['"]|['"]$/g, ''))
    .filter(t => /^\.{0,2}\/?[\w.-]+(\/[\w.-]+)*\.(sh|bash|py|js|mjs|ts|rb|pl)$/.test(t) || /^\.\/[\w./-]+$/.test(t))
    .filter(t => !t.startsWith('/'))
}

// What a scan printed, for telling output from before the run apart from
// output the run brought in: each non-empty line trimmed, its digits turned to
// `#` (so a moved line number or a timing is the same finding), without
// repeats, at most 2000 lines.
export function findingsOf(output: string): string[] {
  const lines = new Set<string>()
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim().replace(/\d+/g, '#')
    if (line !== '') lines.add(line)
    if (lines.size >= 2000) break
  }
  return [...lines]
}
