import { atom, read, update } from 'claude-code'
import { segment } from './segment'
import type { EngineInterface, Hook } from 'claude-code'

import type { HeartbeatState } from '../types'
import { INITIAL_HEARTBEAT } from './state'
import type { PromptHook } from './state'

// The heartbeat-loop skill's timer, in code. Retired once as a Stop hook
// because it fired during collaboration (memory feedback_heartbeat_vs_collab,
// 2026-04-26), so here it starts only on `/harness heartbeat start`, fires only
// after the user has been idle a whole interval with no turn running, and
// never while goal-mode's loop is driving the same repo. Each fire asks for
// the heartbeat-loop skill with the facts gathered here; the skill decides the work.

const heartbeatAtom = atom({ plugin: 'harness', key: 'heartbeat' } as const, INITIAL_HEARTBEAT, { shape: 'heartbeat-1' })

export const TICK_MS = 30_000
const FIRE_MARK = '[harness heartbeat]'
export const FIRE_PROMPT = '[harness heartbeat] Run one fire of the heartbeat-loop skill now (Skill tool, skill "heartbeat-loop").'
const MIN_INTERVAL_MS = 60_000
const GOAL_LOOP_FRESH_MS = 15 * 60_000

// '5m', '90s', '1h' or plain minutes; undefined below a minute or unreadable.
export function parseInterval(text: string): number | undefined {
  const m = text.trim().match(/^(\d+)\s*(s|m|h)?$/i)
  if (m === null) return undefined
  const unit = (m[2] ?? 'm').toLowerCase()
  const ms = Number(m[1]) * (unit === 's' ? 1_000 : unit === 'h' ? 3_600_000 : 60_000)

  return ms >= MIN_INTERVAL_MS ? ms : undefined
}

// Why a tick does not fire, or undefined when it should.
export function holdReason(s: HeartbeatState, now: number, goalLoopActive: boolean): string | undefined {
  if (!s.on) return 'off'
  if (s.busy) return 'a turn is running'
  if (goalLoopActive) return "goal-mode's loop is active in this repo"
  if (now - s.lastUserAt < s.intervalMs) return 'the user was active within the interval'
  if (now - s.lastFireAt < s.intervalMs) return 'fired within the interval'

  return undefined
}

export function fireTag(text: string): string | undefined {
  return text.match(/\[(fire [^\]\n]{1,120}|TOO LONG FOR HEARTBEAT|CONFIDENCE HALT)\]/)?.[0]
}

// The status line piece: short, and gone while the heartbeat is off.
export function heartbeatPiece(s: HeartbeatState, now: number): string {
  if (!s.on) return ''
  const due = Math.max(s.lastUserAt, s.lastFireAt) + s.intervalMs - now

  return `hb ${Math.round(s.intervalMs / 60_000)}m·${due <= 0 ? 'due' : `${Math.ceil(due / 60_000)}m`}`
}

export function heartbeatStatus(s: HeartbeatState, now: number): string {
  if (!s.on) return 'heartbeat off'
  const due = Math.max(s.lastUserAt, s.lastFireAt) + s.intervalMs - now

  return `heartbeat ${Math.round(s.intervalMs / 60_000)}m · ${due <= 0 ? 'due' : `next ~${Math.ceil(due / 60_000)}m`}${s.lastTag ? ` · last ${s.lastTag}` : ''}`
}

async function repoRoot($: EngineInterface): Promise<string | undefined> {
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { timeoutMs: 5_000 })
    return ran.exitCode === 0 ? ran.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

export async function goalLoopActive($: EngineInterface, now: number): Promise<boolean> {
  const root = await repoRoot($)
  if (root === undefined) return false
  try {
    const stat = await $.fs.stat(`${root}/.claude/goal-loop.log`)
    return now - stat.mtimeMs < GOAL_LOOP_FRESH_MS
  } catch {
    return false
  }
}

async function facts($: EngineInterface, s: HeartbeatState): Promise<string> {
  const porcelain = await $.process.run(['git', 'status', '--porcelain'], { timeoutMs: 10_000 }).then(r => r.stdout, () => '')
  const branch = await $.process.run(['git', 'branch', '--show-current'], { timeoutMs: 5_000 }).then(r => r.stdout.trim(), () => '')
  const agents = await $.agent.list().then(list => list.filter(agent => agent.status === 'running').length, () => 0)
  const changed = porcelain.split('\n').filter(line => line.trim() !== '').length

  return [
    '[harness heartbeat facts]',
    `branch: ${branch || '(none)'} · uncommitted files: ${changed}`,
    `running background agents: ${agents}`,
    `previous fire: ${s.lastTag ?? '(none this session)'}`,
    'The user is idle; this is an autonomous fire. One task per fire; continue an in-progress task before starting a new one.',
  ].join('\n')
}

export async function tick($: EngineInterface): Promise<void> {
  const s = await read($, heartbeatAtom)
  const now = await $.clock.now()
  if (!s.on) return
  const hold = holdReason(s, now, await goalLoopActive($, now))
  await segment($, heartbeatPiece(s, now))
  if (hold !== undefined) return
  // A prompt may not start with '/', so the fire asks for the skill by name.
  const text = `${FIRE_PROMPT}\n\n${await facts($, s)}`
  await update($, heartbeatAtom, v => ({ ...v, lastFireAt: now, firing: true }))
  await $.prompt.submit({ text }).catch(async error => {
    $.ui.log(`harness: heartbeat fire not submitted: ${String(error).slice(0, 200)}`, { to: 'debug' })
    await update($, heartbeatAtom, v => ({ ...v, firing: false }))
  })
}

// The user's prompts restart the idle clock; the heartbeat's own submit does not.
export async function heartbeatPrompt($: EngineInterface, e: Parameters<PromptHook>[1], next: Parameters<PromptHook>[2]) {
  if (e.agent_id === undefined) {
    const now = await $.clock.now()
    // The fire is told apart by its text, so a prompt the user types in the
    // meantime still restarts the idle clock.
    const own = e.prompt.includes(FIRE_MARK)
    await update($, heartbeatAtom, s => (own ? { ...s, firing: false } : { ...s, lastUserAt: now }))
  }

  return next(e)
}

export async function heartbeatTurnStart($: EngineInterface, e: Parameters<Hook<'turn.start'>>[1], next: Parameters<Hook<'turn.start'>>[2]) {
  if (e.agentId === undefined) await update($, heartbeatAtom, s => ({ ...s, busy: true }))

  return next(e)
}

export async function heartbeatTurnComplete($: EngineInterface, e: Parameters<Hook<'turn.complete'>>[1], next: Parameters<Hook<'turn.complete'>>[2]) {
  const done = await next(e)
  if (e.agentId === undefined) {
    const tag = fireTag(done.text ?? '')
    await update($, heartbeatAtom, s => ({ ...s, busy: false, lastTag: tag ?? s.lastTag }))
  }

  return done
}

// `/harness heartbeat start [interval] | stop | status`.
export async function heartbeatCommand($: EngineInterface, args: readonly string[]): Promise<string> {
  const [action = 'status', interval = '5m'] = args
  const now = await $.clock.now()
  if (action === 'start') {
    const ms = parseInterval(interval)
    if (ms === undefined) return `Interval "${interval}" is not readable or under a minute; e.g. 5m, 90s.`
    if (await goalLoopActive($, now)) return "goal-mode's loop is active in this repo; the heartbeat would fight it for prompts. Stop that loop first."
    const s = await update($, heartbeatAtom, v => ({ ...v, on: true, intervalMs: ms, lastUserAt: now, lastFireAt: 0, busy: false, firing: false }))
    await segment($, heartbeatPiece(s, now))

    return `Heartbeat on: a heartbeat-loop fire comes after ${Math.round(ms / 60_000)}m with no user prompt and no running turn. ${heartbeatStatus(s, now)}`
  }
  if (action === 'stop') {
    await update($, heartbeatAtom, v => ({ ...v, on: false }))
    await segment($, '')

    return 'Heartbeat off.'
  }

  return heartbeatStatus(await read($, heartbeatAtom), now)
}

export async function heartbeatOn($: EngineInterface): Promise<boolean> {
  return (await read($, heartbeatAtom)).on
}
