import type { EngineInterface } from 'claude-code'

import { readLog } from './log'
import type { LogLine, ModelTotals } from './log'

export const DEFAULT_STATS_DAYS = 7
const DAY_MS = 86_400_000

export type Stats = {
  since: string
  /** Prompts classified (`prompt` lines). */
  prompts: number
  /** Of those, how many skipped the tier classification (no verdict could change the tier). */
  tierSkipped: number
  /** Of those, short follow-ups (they may raise the pick, never lower it). */
  followUps: number
  /** The pick each classified prompt ran on, by tier and by effort. */
  tiers: Record<string, number>
  efforts: Record<string, number>
  /** Prompts whose tier differed from the one before them. */
  tierChanges: number
  /** Main-loop requests answered by another model than the request before (`switch` lines). */
  switches: number
  /** Prompt tokens written again at those switches. */
  switchTokens: number
  /** Classifier answers with a known latency: prompts and spawns in time, and late labels. */
  latency: { answers: number; p50: number; p90: number }
  late: number
  /** Classifier calls that missed the bound while a prompt or spawn waited (`classifier-timeout` lines). */
  timedOut: number
  /** Routed spawns by the tier they got; `kept` is a spawn the classifier did not label in time. */
  spawns: Record<string, number>
  models: Record<string, ModelTotals>
}

const bump = (m: Record<string, number>, key: string) => {
  m[key] = (m[key] ?? 0) + 1
}
/** Nearest-rank percentile of an ascending array. */
const percentile = (sorted: number[], p: number) => (sorted.length === 0 ? 0 : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!)

/** Folds the log lines at or after `sinceMs` into counts. */
export function summarizeLog(lines: readonly LogLine[], sinceMs: number): Stats {
  const s: Stats = {
    since: new Date(sinceMs).toISOString(),
    prompts: 0,
    tierSkipped: 0,
    followUps: 0,
    tiers: {},
    efforts: {},
    tierChanges: 0,
    switches: 0,
    switchTokens: 0,
    latency: { answers: 0, p50: 0, p90: 0 },
    late: 0,
    timedOut: 0,
    spawns: {},
    models: {},
  }
  const ms: number[] = []
  for (const line of lines) {
    const at = Date.parse(line.ts)
    if (!(at >= sinceMs)) continue
    switch (line.event) {
      case 'prompt':
        s.prompts++
        if (!line.wantTier) s.tierSkipped++
        if (line.followUp === true) s.followUps++
        bump(s.tiers, line.tier)
        bump(s.efforts, line.effort ?? 'session')
        if (line.tier !== line.from.tier) s.tierChanges++
        if (typeof line.ms === 'number') ms.push(line.ms)
        break
      case 'spawn':
        bump(s.spawns, line.tier ?? 'kept')
        if (typeof line.ms === 'number') ms.push(line.ms)
        break
      case 'classifier-timeout':
        s.timedOut++
        break
      case 'classifier-late':
        s.late++
        ms.push(line.ms)
        break
      case 'switch':
        s.switches++
        s.switchTokens += line.tokens
        break
      case 'turn':
        for (const [model, t] of Object.entries(line.models)) {
          const m = (s.models[model] ??= { requests: 0, promptTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
          m.requests += t.requests
          m.promptTokens += t.promptTokens
          m.cacheWriteTokens += t.cacheWriteTokens
          m.outputTokens += t.outputTokens
        }
        break
    }
  }
  ms.sort((a, b) => a - b)
  s.latency = { answers: ms.length, p50: percentile(ms, 0.5), p90: percentile(ms, 0.9) }
  return s
}

const counts = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ') || 'none'
const share = (n: number, d: number) => (d === 0 ? '' : ` (${Math.round((n / d) * 100)}%)`)
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

export function formatStats(s: Stats, days: number): string {
  const requests = Object.values(s.models).reduce((a, m) => a + m.requests, 0)
  const models = Object.entries(s.models)
    .sort((a, b) => b[1].requests - a[1].requests)
    .map(
      ([model, m]) =>
        `  ${model}: ${m.requests} requests${share(m.requests, requests)}, ${tokens(m.promptTokens)} prompt tokens, ${tokens(m.cacheWriteTokens)} cache write, ${tokens(m.outputTokens)} output`,
    )
  return [
    `model-tier stats, last ${days} day${days === 1 ? '' : 's'} (since ${s.since}):`,
    `prompts classified: ${s.prompts}; tier classification skipped on ${s.tierSkipped}${share(s.tierSkipped, s.prompts)} (no verdict could change the tier); ${s.followUps} short follow-up${s.followUps === 1 ? '' : 's'}${share(s.followUps, s.prompts)}`,
    `picks: tier ${counts(s.tiers)}; effort ${counts(s.efforts)}`,
    `tier changed after ${s.tierChanges} prompt${s.tierChanges === 1 ? '' : 's'}; ${s.switches} model switch${s.switches === 1 ? '' : 'es'} on the main loop, ${tokens(s.switchTokens)} prompt tokens written again`,
    `classifier: ${s.latency.answers} answers timed, p50 ${s.latency.p50} ms, p90 ${s.latency.p90} ms; late ${s.late}, ${s.timedOut} call${s.timedOut === 1 ? '' : 's'} past the bound`,
    `subagent spawns routed: ${counts(s.spawns)}`,
    `main loop by model (${requests} requests):`,
    ...(models.length > 0 ? models : ['  none logged']),
  ].join('\n')
}

/** `/tier stats [days]`: the log's last `days` days, summarized. */
export async function statsCommand($: EngineInterface, arg: string): Promise<string> {
  const days = arg === '' ? DEFAULT_STATS_DAYS : Number(arg)
  if (!Number.isFinite(days) || days <= 0) return 'Usage: /tier stats [days]  (default 7)'
  const lines = await readLog($)
  const sinceMs = (await $.clock.now()) - days * DAY_MS
  if (!lines.some(line => Date.parse(line.ts) >= sinceMs)) return `model-tier stats: no log lines in the last ${days} days (~/.claude/model-tier.log).`
  return formatStats(summarizeLog(lines, sinceMs), days)
}
