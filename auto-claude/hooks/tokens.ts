// Token use per milestone (1.20.0): what each milestone cost, read from every
// model step the owning session takes (turn.step), main loop and subagents apart.
//
// "Build observable systems … visibility into token consumption" and "multi-agent
// systems use roughly 10-15x more tokens … do the math" (Anthropic, Building
// Effective AI Agents, 2025). Runs work in ultracode (1.7.0), a standing multi-agent
// mode, so whether that pays off per milestone is measured here, not guessed.
//
// The helpers here are pure; register.ts keeps the ledger in the plugin store
// (one key per repository, so a reload keeps it) and logs one `tokens` event per
// finished milestone.

export type TokenCounts = { steps: number; input: number; output: number; cacheRead: number; cacheWrite: number }
export type TokenBucket = { main: TokenCounts; sub: TokenCounts }
// `goals`: the milestones being built, by their queue condition; `other`: steps taken
// while no milestone was being built (planning, replans, the final check's turn).
export type TokenLedger = { run: number; goals: Record<string, TokenBucket>; other: TokenBucket }

// The fields of a step's usage, as the API reports them (model-tier reads the same ones).
export type StepUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export const zeroCounts = (): TokenCounts => ({ steps: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
export const zeroBucket = (): TokenBucket => ({ main: zeroCounts(), sub: zeroCounts() })
export const emptyLedger = (run: number): TokenLedger => ({ run, goals: {}, other: zeroBucket() })

const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0)

function addCounts(c: TokenCounts, u: StepUsage): TokenCounts {
  return {
    steps: c.steps + 1,
    input: c.input + n(u.input_tokens),
    output: c.output + n(u.output_tokens),
    cacheRead: c.cacheRead + n(u.cache_read_input_tokens),
    cacheWrite: c.cacheWrite + n(u.cache_creation_input_tokens),
  }
}

// One step counted: to the milestone being built, or to `other`; a ledger of
// another run starts over.
export function addStep(ledger: TokenLedger | undefined, run: number, goal: string | undefined, subagent: boolean, usage: StepUsage): TokenLedger {
  const base = ledger !== undefined && ledger.run === run ? ledger : emptyLedger(run)
  const bucket = goal === undefined ? base.other : (base.goals[goal] ?? zeroBucket())
  const next: TokenBucket = subagent ? { ...bucket, sub: addCounts(bucket.sub, usage) } : { ...bucket, main: addCounts(bucket.main, usage) }
  return goal === undefined ? { ...base, other: next } : { ...base, goals: { ...base.goals, [goal]: next } }
}

export const isEmpty = (b: TokenBucket): boolean => b.main.steps === 0 && b.sub.steps === 0

// A finished milestone's bucket, taken out of the ledger.
export function takeGoal(ledger: TokenLedger, goal: string): { bucket: TokenBucket | undefined; ledger: TokenLedger } {
  const bucket = ledger.goals[goal]
  if (bucket === undefined) return { bucket: undefined, ledger }
  const { [goal]: _taken, ...rest } = ledger.goals
  return { bucket, ledger: { ...ledger, goals: rest } }
}

// Every token kind of a count, summed: the size a milestone is ranked by.
export const countTotal = (c: TokenCounts): number => c.input + c.output + c.cacheRead + c.cacheWrite
export const bucketTotal = (b: TokenBucket): number => countTotal(b.main) + countTotal(b.sub)

// Parsed back from a logged `tokens` event; undefined when it is not one.
export function bucketOf(o: Record<string, unknown>): TokenBucket | undefined {
  const counts = (x: unknown): TokenCounts | undefined => {
    if (x === null || typeof x !== 'object') return undefined
    const c = x as Record<string, unknown>
    return { steps: n(c.steps), input: n(c.input), output: n(c.output), cacheRead: n(c.cacheRead), cacheWrite: n(c.cacheWrite) }
  }
  const main = counts(o.main)
  const sub = counts(o.sub)
  return main === undefined || sub === undefined ? undefined : { main, sub }
}

export function sumBuckets(buckets: readonly TokenBucket[]): TokenBucket {
  const add = (a: TokenCounts, b: TokenCounts): TokenCounts => ({ steps: a.steps + b.steps, input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite })
  return buckets.reduce((acc, b) => ({ main: add(acc.main, b.main), sub: add(acc.sub, b.sub) }), zeroBucket())
}

// 1234 → 1.2k, 4_500_000 → 4.5M.
export function shortCount(x: number): string {
  if (x >= 1e9) return `${(x / 1e9).toFixed(1)}G`
  if (x >= 1e6) return `${(x / 1e6).toFixed(1)}M`
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)}k`
  return String(Math.round(x))
}
