import type { EngineInterface } from 'claude-code'

import type { Effort, Tier } from '../types'
import { labelPrompt } from './label'

const TIERS: readonly string[] = ['haiku', 'sonnet', 'opus', 'fable']
const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh']
export const DEFAULT_EVAL_PATH = 'model-tier/eval/prompts.jsonl'
// Generous so a slow answer is still scored; latency is recorded separately.
const EVAL_TIMEOUT_MS = 30_000

/** One line of the prompt set. */
export type EvalCase = { prompt: string; tier: Tier; effort: Effort; why: string }

export type EvalResult = {
  prompt: string
  want: { tier: Tier; effort: Effort }
  got: { tier: Tier | null; effort: Effort | null }
  tierOk: boolean
  effortOk: boolean
  tierTimedOut: boolean
  effortTimedOut: boolean
  ms: number
}

export type EvalRun = {
  ranAt: string
  file: string
  classifierModel: string
  timeoutMs: number
  cases: number
  tierAccuracy: number
  effortAccuracy: number
  timeouts: { tier: number; effort: number }
  latencyMs: { p50: number; p90: number; max: number }
  /** Prompts whose labelling took longer than the configured `classifierTimeoutMs`: in a session they keep the old pick. */
  overProductionTimeout: { timeoutMs: number; count: number }
  results: EvalResult[]
}

/** Parses the jsonl prompt set; throws naming the first bad line. */
export function parseCases(text: string): EvalCase[] {
  const cases: EvalCase[] = []
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return
    const c = JSON.parse(line) as Partial<EvalCase>
    if (typeof c.prompt !== 'string' || !TIERS.includes(c.tier as string) || !EFFORTS.includes(c.effort as string)) {
      throw new Error(`line ${i + 1}: needs prompt, tier (${TIERS.join('|')}) and effort (${EFFORTS.join('|')})`)
    }
    cases.push({ prompt: c.prompt, tier: c.tier as Tier, effort: c.effort as Effort, why: String(c.why ?? '') })
  })
  return cases
}

/** Nearest-rank percentile of an ascending array. */
const percentile = (sorted: number[], p: number) => (sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!)
const ratio = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 1000)

/**
 * Labels each case with the production `labelPrompt`, one prompt at a time so
 * latencies do not compete. The tier is scored uncapped (`maxAuto: 'fable'`):
 * the eval measures the labels, and the cap is routing policy applied after.
 */
export async function runEval($: EngineInterface, cases: EvalCase[], o: { model: string; productionTimeoutMs: number; file: string }): Promise<EvalRun> {
  const results: EvalResult[] = []
  for (const c of cases) {
    const start = await $.clock.now()
    const got = await labelPrompt($, c.prompt, { model: o.model, timeoutMs: EVAL_TIMEOUT_MS, maxAuto: 'fable', wantTier: true, wantEffort: true })
    const ms = (await $.clock.now()) - start
    results.push({
      prompt: c.prompt,
      want: { tier: c.tier, effort: c.effort },
      got: { tier: got.tier ?? null, effort: got.effort ?? null },
      tierOk: got.tier === c.tier,
      effortOk: got.effort === c.effort,
      tierTimedOut: got.tierTimedOut,
      effortTimedOut: got.effortTimedOut,
      ms,
    })
  }
  const sorted = results.map(r => r.ms).sort((a, b) => a - b)
  return {
    ranAt: new Date(await $.clock.now()).toISOString(),
    file: o.file,
    classifierModel: o.model,
    timeoutMs: EVAL_TIMEOUT_MS,
    cases: results.length,
    tierAccuracy: ratio(results.filter(r => r.tierOk).length, results.length),
    effortAccuracy: ratio(results.filter(r => r.effortOk).length, results.length),
    timeouts: { tier: results.filter(r => r.tierTimedOut).length, effort: results.filter(r => r.effortTimedOut).length },
    latencyMs: { p50: percentile(sorted, 0.5), p90: percentile(sorted, 0.9), max: sorted.at(-1) ?? 0 },
    overProductionTimeout: { timeoutMs: o.productionTimeoutMs, count: results.filter(r => r.ms > o.productionTimeoutMs).length },
    results,
  }
}

export function summarize(run: EvalRun, written: string): string {
  const misses = run.results.filter(r => !r.tierOk || !r.effortOk)
  return [
    `model-tier eval: ${run.cases} prompts on ${run.classifierModel}`,
    `tier accuracy ${run.tierAccuracy}, effort accuracy ${run.effortAccuracy}`,
    `timeouts tier ${run.timeouts.tier}, effort ${run.timeouts.effort}; latency p50 ${run.latencyMs.p50} ms, p90 ${run.latencyMs.p90} ms, max ${run.latencyMs.max} ms`,
    `over the ${run.overProductionTimeout.timeoutMs} ms production timeout: ${run.overProductionTimeout.count}`,
    ...misses.map(
      r =>
        `miss: ${r.prompt.slice(0, 60)}: tier ${r.got.tier ?? '-'} (want ${r.want.tier}), effort ${r.got.effort ?? '-'} (want ${r.want.effort})`,
    ),
    `written to ${written}`,
  ].join('\n')
}

/** `/tier eval [path]`: reads the set, runs it, writes `last-run.json` beside it, returns the summary. */
export async function evalCommand($: EngineInterface, arg: string, o: { model: string; productionTimeoutMs: number }): Promise<string> {
  const given = arg === '' ? DEFAULT_EVAL_PATH : arg
  const path = given.startsWith('/') ? given : `${(await $.session.cwd()).replace(/\/$/, '')}/${given}`
  let cases: EvalCase[]
  try {
    cases = parseCases(await $.fs.read(path))
  } catch (err) {
    return `model-tier eval: cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`
  }
  if (cases.length === 0) return `model-tier eval: ${path} has no prompts`
  const run = await runEval($, cases, { ...o, file: given })
  const out = `${path.slice(0, path.lastIndexOf('/'))}/last-run.json`
  await $.fs.write(out, `${JSON.stringify(run, null, 2)}\n`)
  return summarize(run, out)
}
