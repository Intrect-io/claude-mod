import type { Tier } from '../types'

const FAMILIES: readonly Tier[] = ['haiku', 'sonnet', 'opus', 'fable']

/** The context-window flag a resolved id may carry (`claude-opus-5-5[1m]`): not part of the id sent. */
export const stripFlag = (id: string): string => id.replace(/\[[^\]]*\]$/, '')

/**
 * The family and version of a Claude model id: `claude-opus-5-5[1m]` is opus 5.5,
 * `claude-sonnet-4-5-20250929` sonnet 4.5, `claude-3-5-haiku-20241022` haiku 3.5.
 * A date stamp (8 digits) is not a version part. Anything that is no Claude id
 * with a family and a version (an alias, codex, a router's own name) is undefined.
 */
export function parseClaudeModel(id: string): { tier: Tier; version: number[] } | undefined {
  const base = stripFlag(id.trim().toLowerCase())
  if (!base.startsWith('claude-')) return undefined
  const parts = base.slice('claude-'.length).split('-')
  const tier = FAMILIES.find(f => parts.includes(f))
  if (tier === undefined) return undefined
  const version = parts.filter(p => /^\d{1,2}$/.test(p)).map(Number)
  return version.length === 0 ? undefined : { tier, version }
}

/** Whether version `a` is strictly above `b`, part by part (5.5 > 5 and 5.5 > 4.9). */
export function isHigher(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

/**
 * The id to adopt for `current`'s tier when the model that answered is a newer
 * version of the same family; undefined when it is the same, older, another
 * family, or no Claude id at all.
 */
export function newerModel(current: string, answered: string): string | undefined {
  const a = parseClaudeModel(answered)
  const c = parseClaudeModel(current)
  if (a === undefined || c === undefined || a.tier !== c.tier) return undefined
  return isHigher(a.version, c.version) ? stripFlag(answered.trim()) : undefined
}

/** A stored `{ tier: id }` map reduced to the entries that are Claude ids of that tier. */
export function validLearned(raw: unknown): Partial<Record<Tier, string>> {
  const out: Partial<Record<Tier, string>> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const tier of FAMILIES) {
    const id = (raw as Record<string, unknown>)[tier]
    if (typeof id === 'string' && parseClaudeModel(id)?.tier === tier) out[tier] = stripFlag(id)
  }
  return out
}
