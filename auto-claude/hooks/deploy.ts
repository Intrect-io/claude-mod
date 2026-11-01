// Deploying after each merge. The repository opts in with .claude/auto-deploy.json,
// read once when the run starts, so a milestone that edits the file cannot change
// what this run executes. The driver runs it, never the model (its deploy and
// release commands stay refused), in a fresh checkout of what was merged.

export type DeploySpec = {
  command: string
  // CodeQL languages scanned before each deploy; empty: no scan.
  codeql: string[]
  timeoutMs: number
}

export const DEPLOY_FILE = '.claude/auto-deploy.json'
const DEFAULT_TIMEOUT_MS = 10 * 60_000
// $.process.run allows ten minutes at most.
const MAX_TIMEOUT_MS = 10 * 60_000

// `{ "command": "bash scripts/deploy.sh", "codeql": "python" | ["python", "javascript"], "timeoutSec": 600 }`
export function parseDeploy(text: string): DeploySpec | { error: string } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: `${DEPLOY_FILE} is not JSON (${String(error).slice(0, 80)})` }
  }
  if (typeof value !== 'object' || value === null) return { error: `${DEPLOY_FILE} must be an object` }
  const v = value as { command?: unknown; codeql?: unknown; timeoutSec?: unknown }
  if (typeof v.command !== 'string' || v.command.trim() === '') return { error: `${DEPLOY_FILE} needs a "command" string` }
  const langs = v.codeql === undefined ? [] : typeof v.codeql === 'string' ? [v.codeql] : v.codeql
  if (!Array.isArray(langs) || !langs.every(l => typeof l === 'string' && /^[a-z-]+$/.test(l))) {
    return { error: `${DEPLOY_FILE} "codeql" must be a language name or a list of them (python, javascript, …)` }
  }
  if (v.timeoutSec !== undefined && (typeof v.timeoutSec !== 'number' || v.timeoutSec <= 0)) return { error: `${DEPLOY_FILE} "timeoutSec" must be a positive number` }
  const timeoutMs = v.timeoutSec === undefined ? DEFAULT_TIMEOUT_MS : Math.min(MAX_TIMEOUT_MS, v.timeoutSec * 1000)

  return { command: v.command.trim(), codeql: langs as string[], timeoutMs }
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
