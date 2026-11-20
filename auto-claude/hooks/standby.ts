// Always-on: what a run does between cycles. A run started with --always-on
// does not end when its final check passes: it stands by, with no model turn,
// while the driver polls the sources that can give it work (Linear, the live
// service's smoke check, the default branch's CI and labelled GitHub issues).
// Each new event becomes a queue line, through the same dedupe as Linear's
// (a stamp per event, at most MAX_FOLLOW_UPS follow-ups, MAX_EVENT_LINES per
// poll), and a queue line with work in it wakes the run for a new cycle.

import type { EngineInterface } from 'claude-code'

import type { AutoRecord } from '../types'
import { fetchRemote, LOCAL, out, refOf, run } from './io'
import { repoSlug } from './ship'

// The session must have had no turn for this long before a wake prompts it:
// a person may be using the session while the run stands by.
export const WAKE_QUIET_MS = 2 * 60_000
// Smoke checks failing in a row, in standby, before a repair is queued.
export const HEALTH_FAILS = 2
// New lines one poll may queue, and follow-ups per event id (as Linear's).
export const MAX_EVENT_LINES = 5
export const MAX_EVENT_FOLLOW_UPS = 2
export const DAY_MS = 24 * 3_600_000
// Context fill (percent) from which entering standby compacts the session.
export const COMPACT_PERCENT = 30
const POLL_TIMEOUT_MS = 60_000

export type StandbyConfig = {
  healthMs: number
  githubMs: number
  issueLabel: string
  maxMergesPerDay: number
}

export type Source = 'health' | 'github'

// One thing that happened outside the run, keyed for dedupe: `id` names it
// (ci:<run id>, gh#<number>), `stamp` changes when it changes.
// `followUp` undefined: a change to it is covered without a new line.
export type StandbyEvent = { id: string; stamp: string; line: string; followUp?: string; workflow?: string; runId?: number }

// The sources this run can poll at all.
export function sourcesOf(r: Pick<AutoRecord, 'remote' | 'ciMode' | 'deploy'>): Source[] {
  const s: Source[] = []
  if (r.deploy?.smoke !== undefined) s.push('health')
  if (r.remote !== LOCAL && r.ciMode === 'github') s.push('github')
  return s
}

// The sources whose timer is due now.
export function dueSources(r: Pick<AutoRecord, 'remote' | 'ciMode' | 'deploy' | 'timers'>, now: number): Source[] {
  return sourcesOf(r).filter(s => (r.timers?.[s] ?? 0) <= now)
}

export function nextTimers(r: Pick<AutoRecord, 'timers'>, polled: readonly Source[], cfg: StandbyConfig, now: number): NonNullable<AutoRecord['timers']> {
  const t = { ...r.timers }
  for (const s of polled) t[s] = now + (s === 'health' ? cfg.healthMs : cfg.githubMs)
  return t
}

// Third-party text going into a queue line: one line, no field separator
// (a `::` would add a check or a base of the sender's choosing), bounded.
export function clean(text: string, max = 100): string {
  return text.replace(/\s+/g, ' ').replace(/::+/g, ':').replace(/[[\]]/g, '').trim().slice(0, max)
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure'])

// `gh run list --json databaseId,headSha,conclusion,workflowName`: the runs
// that failed on the default branch's current tip. Older tips are history: a
// later commit either fixed them or fails again on its own.
export function failedRuns(json: string, headSha: string): Array<{ id: number; workflow: string }> {
  let rows: Array<{ databaseId?: number; headSha?: string; conclusion?: string; workflowName?: string }>
  try {
    rows = JSON.parse(json) as typeof rows
  } catch {
    return []
  }
  if (!Array.isArray(rows) || headSha === '') return []
  return rows
    .filter(x => typeof x.databaseId === 'number' && x.headSha === headSha && FAILED.has(String(x.conclusion)))
    .map(x => ({ id: x.databaseId!, workflow: String(x.workflowName ?? 'CI') }))
}

// `gh issue list --json number,title,updatedAt`.
export function openIssues(json: string): Array<{ number: number; title: string; updatedAt: string }> {
  let rows: Array<{ number?: number; title?: string; updatedAt?: string }>
  try {
    rows = JSON.parse(json) as typeof rows
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  return rows.filter(x => typeof x.number === 'number').map(x => ({ number: x.number!, title: String(x.title ?? ''), updatedAt: String(x.updatedAt ?? '') }))
}

export function ciEvent(id: number, workflow: string, branch: string, sha: string): StandbyEvent {
  const what = `[ci:${id}] The "${clean(workflow, 60)}" workflow passes on ${branch} again: run ${id} failed at ${sha.slice(0, 7)}; the cause is found (\`gh run view ${id} --log-failed\`) and fixed on this branch`
  return { id: `ci:${id}`, stamp: sha, line: `- [ ] ${what}`, followUp: `- [ ] ${what}`, workflow, runId: id }
}

// Only the number and title go in the line: the body and comments are
// third-party text the model reads itself while it builds the line. A later
// change (anyone's comment, an edit after labelling) queues nothing: the label
// is the trust gate, and only a fresh label (a new issue) is new work.
export function issueEvent(n: number, title: string, updatedAt: string): StandbyEvent {
  const head = `[gh#${n}] ${clean(title)}`
  return {
    id: `gh#${n}`,
    stamp: updatedAt,
    line: `- [ ] ${head}: what GitHub issue #${n} asks is resolved on this branch (read it with \`gh issue view ${n}\`)`,
  }
}

// The lines new events add: an id never seen gets its line, one seen with a
// newer stamp a follow-up (at most MAX_EVENT_FOLLOW_UPS), MAX_EVENT_LINES in all.
// What exists at the first poll is queued too: the plan never saw GitHub, and
// a labelled issue or a red default branch is work the person wants done.
export function eventLines(
  events: readonly StandbyEvent[],
  seen: Readonly<Record<string, string>>,
  followUps: Readonly<Record<string, number>>,
): { lines: string[]; seen: Record<string, string>; followUps: Record<string, number> } {
  const s = { ...seen }
  const f = { ...followUps }
  const lines: string[] = []
  for (const e of events) {
    const before = s[e.id]
    if (before === e.stamp) continue
    if (lines.length >= MAX_EVENT_LINES) break
    if (before === undefined) {
      lines.push(e.line)
    } else {
      if (e.followUp === undefined || (f[e.id] ?? 0) >= MAX_EVENT_FOLLOW_UPS) {
        s[e.id] = e.stamp
        continue
      }
      f[e.id] = (f[e.id] ?? 0) + 1
      lines.push(e.followUp)
    }
    s[e.id] = e.stamp
  }
  return { lines, seen: s, followUps: f }
}

// GitHub issue numbers a queue line resolves ([gh#12]).
export function lineGhIssues(condition: string): number[] {
  const m = condition.match(/^\[gh#(\d+)\]/)
  return m === null ? [] : [Number(m[1])]
}

// Merges in the last 24 h, as kept (older ones dropped).
export function recentMerges(times: readonly number[] | undefined, now: number): number[] {
  return (times ?? []).filter(t => now - t < DAY_MS)
}

// The rolling cap: a wake is held back while the last 24 h already hold this many merges.
export function dayCapHit(times: readonly number[] | undefined, now: number, max: number): boolean {
  return max > 0 && recentMerges(times, now).length >= max
}

// Why a finished run does not plan the next one itself (register.ts
// continueRun), or undefined when it does: it goes on only while runs make
// progress and stay under the rolling caps.
export function nextRunBlock(r: { merges: number; startedAt: number; runTimes?: readonly number[]; mergeTimes?: readonly number[] }, now: number, cfg: { maxRunsPerDay: number; maxMergesPerDay: number }): string | undefined {
  if (r.merges === 0) return 'this run merged nothing, so another would likely do the same'
  const runs = recentMerges(r.runTimes ?? [r.startedAt], now).length
  if (runs >= cfg.maxRunsPerDay) return `${runs} runs started in the last 24 h, the cap (maxRunsPerDay)`
  if (dayCapHit(r.mergeTimes, now, cfg.maxMergesPerDay)) return `${recentMerges(r.mergeTimes, now).length} merges in the last 24 h, the cap (maxMergesPerDay)`
  return undefined
}

// The line each cycle adds under ## Cycles in auto-plan.md: what woke it and what it did.
export function cycleLine(r: Pick<AutoRecord, 'cycle' | 'wokeFor' | 'merges' | 'held' | 'deploys' | 'cycleBase'>, at: string): string {
  const base = r.cycleBase ?? { merges: 0, held: 0, deploys: 0 }
  const why = (r.wokeFor ?? []).length > 0 ? `woke for ${r.wokeFor!.join(', ')}` : 'woke'
  return `- cycle ${r.cycle ?? 0}, ${at}: ${why}; merged ${r.merges - base.merges}, held ${r.held - base.held}, deployed ${(r.deploys ?? 0) - base.deploys}`
}

// Appends a line under the plan's ## Cycles section (made at the end when missing).
export function withCycle(plan: string, line: string): string {
  const head = /^## Cycles\s*$/m
  if (!head.test(plan)) return `${plan.trimEnd()}\n\n## Cycles\n\n${line}\n`
  const lines = plan.split('\n')
  const at = lines.findIndex(l => head.test(l))
  let end = at + 1
  while (end < lines.length && !/^## /.test(lines[end]!)) end++
  while (end > at + 1 && lines[end - 1]!.trim() === '') end--
  lines.splice(end, 0, line)
  return lines.join('\n')
}

// The ids a set of queue lines came from, for the wake's notice and the cycle line.
export function eventIds(lines: readonly string[]): string[] {
  return lines.map(l => l.match(/^- \[ \] \[([^\]]+)\]/)?.[1]).filter((x): x is string => x !== undefined)
}

// The live service's smoke check, run as the deploy runs it: in a fresh
// detached checkout of the default branch (the root checkout does not follow
// merges in github mode, so a smoke check naming a repo script could fail
// there while live is fine). Exit 0 is healthy; no checkout is no verdict.
export async function pollHealth($: EngineInterface, r: AutoRecord): Promise<{ ok: boolean; out: string }> {
  const smoke = r.deploy?.smoke
  if (smoke === undefined) return { ok: true, out: '' }
  const dir = `${r.root}/worktrees/auto-health`
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  await fetchRemote($, r, r.root)
  const made = await run($, ['git', '-C', r.root, 'worktree', 'add', '--detach', dir, refOf(r)], r.root)
  if (made.exitCode !== 0) return { ok: true, out: `no checkout: ${out(made)}` }
  try {
    const got = await run($, ['bash', '-lc', smoke], dir, POLL_TIMEOUT_MS)
    return { ok: got.exitCode === 0, out: `exited ${got.exitCode}: ${out(got)}`.slice(0, 300) }
  } finally {
    await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  }
}

// `--repo owner/name` of the pushed remote: gh alone may pick a fork's parent (ship.ts repoSlug).
export async function repoArgs($: EngineInterface, r: Pick<AutoRecord, 'root' | 'remote'>): Promise<string[]> {
  if (r.remote === LOCAL) return []
  const slug = repoSlug((await run($, ['git', '-C', r.root, 'remote', 'get-url', r.remote], r.root, 15_000)).stdout)
  return slug === undefined ? [] : ['--repo', slug]
}

// Failed runs on the default branch's tip and open issues with the label.
export async function pollGithub($: EngineInterface, r: AutoRecord, label: string): Promise<{ events: StandbyEvent[]; error?: string }> {
  await fetchRemote($, r, r.root)
  const repo = await repoArgs($, r)
  const sha = (await run($, ['git', '-C', r.root, 'rev-parse', refOf(r)], r.root, 15_000)).stdout.trim()
  const runs = await run($, ['gh', 'run', 'list', ...repo, '--branch', r.defaultBranch, '--limit', '20', '--json', 'databaseId,headSha,conclusion,workflowName'], r.root, POLL_TIMEOUT_MS)
  const events: StandbyEvent[] = []
  let error: string | undefined
  if (runs.exitCode === 0) for (const f of failedRuns(runs.stdout, sha)) events.push(ciEvent(f.id, f.workflow, r.defaultBranch, sha))
  else error = `gh run list: ${out(runs)}`
  if (label !== '') {
    const issues = await run($, ['gh', 'issue', 'list', ...repo, '--label', label, '--state', 'open', '--limit', '30', '--json', 'number,title,updatedAt'], r.root, POLL_TIMEOUT_MS)
    if (issues.exitCode === 0) for (const i of openIssues(issues.stdout)) events.push(issueEvent(i.number, i.title, i.updatedAt))
    else error ??= `gh issue list: ${out(issues)}`
  }
  return { events, ...(error !== undefined ? { error: error.slice(0, 300) } : {}) }
}
