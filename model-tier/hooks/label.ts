import type { EngineInterface } from 'claude-code'

import type { Effort, Tier } from '../types'

export const RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }
export const capTier = (t: Tier, max: Tier): Tier => (RANK[t] > RANK[max] ? max : t)

// The top label names a rare case outright: label names steer the classifier
// (see EFFORT_LABELS), and fable is the scarcest, most rate-limited tier. The
// label set stays the same under a lower `maxAutoTier`, so the other three
// labels classify as before; only the tier it maps to is capped.
const LABELS = ['trivial', 'standard', 'complex', 'exceptionally-hard'] as const
const LABEL_TIER: Record<(typeof LABELS)[number], Tier> = {
  trivial: 'haiku',
  standard: 'sonnet',
  complex: 'opus',
  'exceptionally-hard': 'fable',
}
// Named for how hard the problem is to think through, not how long the answer
// is: measured live, 'quick-answer' caught a hard design question that asked
// for a three-line reply.
const EFFORT_LABELS = ['recall-or-lookup', 'routine-reasoning', 'tricky-problem', 'hard-open-problem'] as const
const LABEL_EFFORT: Record<(typeof EFFORT_LABELS)[number], Effort> = {
  'recall-or-lookup': 'low',
  'routine-reasoning': 'medium',
  'tricky-problem': 'high',
  'hard-open-problem': 'xhigh',
}
const CLASSIFY_CHARS = 4000

// A classifier's answer, or the timeout that beat it.
type Labelled<T> = { value: T | undefined; timedOut: boolean }

const TIMED_OUT = Symbol('timed out')

/** The first of `labelled` and a `timeoutMs` sleep, so a slow classifier never holds the prompt. */
async function within<T>($: EngineInterface, labelled: Promise<T | undefined>, timeoutMs: number): Promise<Labelled<T>> {
  const stop = new AbortController()
  // A sleep that fails or is aborted never wins the race: only a real timeout does.
  const timeout = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(
    () => TIMED_OUT,
    () => new Promise<typeof TIMED_OUT>(() => {}),
  )
  try {
    const got = await Promise.race([labelled, timeout])
    return got === TIMED_OUT ? { value: undefined, timedOut: true } : { value: got, timedOut: false }
  } finally {
    stop.abort()
  }
}

function classify($: EngineInterface, text: string, model: string, timeoutMs: number, max: Tier): Promise<Labelled<Tier>> {
  const labelled = $.model.classify(text.slice(0, CLASSIFY_CHARS), LABELS, { model }).then(label =>
    label === undefined || !(label in LABEL_TIER) ? undefined : capTier(LABEL_TIER[label as (typeof LABELS)[number]], max),
  )
  return within($, labelled, timeoutMs)
}

function classifyEffort($: EngineInterface, text: string, model: string, timeoutMs: number): Promise<Labelled<Effort>> {
  const labelled = $.model.classify(text.slice(0, CLASSIFY_CHARS), EFFORT_LABELS, { model }).then(found =>
    found !== undefined && found in LABEL_EFFORT ? LABEL_EFFORT[found as (typeof EFFORT_LABELS)[number]] : undefined,
  )
  return within($, labelled, timeoutMs)
}

export type LabelOptions = {
  model: string
  timeoutMs: number
  /** The tier a verdict is capped at. */
  maxAuto: Tier
  wantTier: boolean
  wantEffort: boolean
}

/** What the classifier said; a label outside the set or a failed call leaves the field unset. */
export type PromptLabels = {
  tier?: Tier
  effort?: Effort
  tierTimedOut: boolean
  effortTimedOut: boolean
}

/**
 * The production labelling of one prompt: tier and effort classified in
 * parallel, each bounded by `timeoutMs`. Every caller (prompt hook, subagent
 * routing, /tier eval) goes through here so the eval measures what ships.
 */
export async function labelPrompt($: EngineInterface, text: string, o: LabelOptions): Promise<PromptLabels> {
  const [tier, effort] = await Promise.all([
    o.wantTier ? classify($, text, o.model, o.timeoutMs, o.maxAuto).catch(() => undefined) : undefined,
    o.wantEffort ? classifyEffort($, text, o.model, o.timeoutMs).catch(() => undefined) : undefined,
  ])
  return {
    tier: tier?.value,
    effort: effort?.value,
    tierTimedOut: tier?.timedOut === true,
    effortTimedOut: effort?.timedOut === true,
  }
}
