// Deploying after each merge. What is deployed comes from .claude/auto-deploy.json
// (committed by the person, read once when the run starts) or, without it,
// from the plan's Deploy / Smoke check / CodeQL lines, fixed when
// auto_plan_ready accepts the plan; either way a milestone that edits it
// cannot change what this run executes. The driver runs it, never the model
// (its deploy and release commands stay refused), in a fresh checkout of what
// was merged.

import type { PlanDeploy } from './plan'

export type DeploySpec = {
  command: string
  // CodeQL languages scanned before each deploy; empty: no scan.
  codeql: string[]
  timeoutMs: number
  // Run right after the deploy; it passes only when the deployed service works.
  smoke?: string
  source?: 'file' | 'plan'
}

export const DEPLOY_FILE = '.claude/auto-deploy.json'
const DEFAULT_TIMEOUT_MS = 10 * 60_000
// $.process.run allows ten minutes at most.
const MAX_TIMEOUT_MS = 10 * 60_000

// `{ "command": "bash scripts/deploy.sh", "codeql": "python" | ["python", "javascript"], "timeoutSec": 600, "smoke": "curl -fsS https://x/health" }`
export function parseDeploy(text: string): DeploySpec | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: `${DEPLOY_FILE} is not JSON (${String(error).slice(0, 80)})` }
  }
  if (typeof value !== 'object' || value === null) return { error: `${DEPLOY_FILE} must be an object` }
  const v = value as { command?: unknown; codeql?: unknown; timeoutSec?: unknown; smoke?: unknown }
  if (typeof v.command !== 'string' || v.command.trim() === '') return { error: `${DEPLOY_FILE} needs a "command" string` }
  const langs = v.codeql === undefined ? [] : typeof v.codeql === 'string' ? [v.codeql] : v.codeql
  if (!Array.isArray(langs) || !langs.every(l => typeof l === 'string' && /^[a-z-]+$/.test(l))) {
    return { error: `${DEPLOY_FILE} "codeql" must be a language name or a list of them (python, javascript, …)` }
  }
  if (v.timeoutSec !== undefined && (typeof v.timeoutSec !== 'number' || v.timeoutSec <= 0)) return { error: `${DEPLOY_FILE} "timeoutSec" must be a positive number` }
  const timeoutMs = v.timeoutSec === undefined ? DEFAULT_TIMEOUT_MS : Math.min(MAX_TIMEOUT_MS, v.timeoutSec * 1000)
  if (v.smoke !== undefined && (typeof v.smoke !== 'string' || v.smoke.trim() === '')) return { error: `${DEPLOY_FILE} "smoke" must be a command string` }
  const smoke = typeof v.smoke === 'string' ? v.smoke.trim() : undefined

  return { command: v.command.trim(), codeql: langs as string[], timeoutMs, ...(smoke !== undefined ? { smoke } : {}), source: 'file' }
}

export function specOfPlan(d: Extract<PlanDeploy, { kind: 'command' }>): DeploySpec {
  return { command: d.command, codeql: d.codeql, timeoutMs: DEFAULT_TIMEOUT_MS, smoke: d.smoke, source: 'plan' }
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

export type SarifCount = { errors: number; warnings: number; top: string[] }

// Results whose level (its own, else its rule's default) is `error` block a deploy.
export function countSarif(text: string): SarifCount | undefined {
  let sarif: { runs?: Array<{ results?: Array<{ ruleId?: string; level?: string; locations?: Array<{ physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }> }>; tool?: { driver?: { rules?: Array<{ id?: string; defaultConfiguration?: { level?: string } }> } } }> }
  try {
    sarif = JSON.parse(text)
  } catch {
    return undefined
  }
  let errors = 0
  let warnings = 0
  const top: string[] = []
  for (const r of sarif.runs ?? []) {
    const ruleLevel = new Map((r.tool?.driver?.rules ?? []).map(rule => [rule.id, rule.defaultConfiguration?.level]))
    for (const result of r.results ?? []) {
      const level = result.level ?? ruleLevel.get(result.ruleId) ?? 'warning'
      if (level === 'error') {
        errors++
        const loc = result.locations?.[0]?.physicalLocation
        if (top.length < 5) top.push(`${result.ruleId ?? '?'} ${loc?.artifactLocation?.uri ?? '?'}:${loc?.region?.startLine ?? '?'}`)
      } else if (level === 'warning') warnings++
    }
  }

  return { errors, warnings, top }
}

export function codeqlSuite(language: string): string {
  return `codeql/${language}-queries:codeql-suites/${language}-security-and-quality.qls`
}
