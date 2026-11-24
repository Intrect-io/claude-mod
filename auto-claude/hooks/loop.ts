// The loop: one queue line at a time, built in its own git worktree and judged
// at every Stop (the line's own check, run here; uncommitted changes refused;
// then an independent evaluator). Moved from goal-mode 0.7.0, which drove it
// through files a driver wrote (a gate credit, a base ref) and `/goal-mode
// loop on`; the driver now calls startNext itself, so a start it wants is
// never refused or left waiting on a command. The loop still writes
// .claude/goal-loop.log: the driver reads its events from there, and the
// harness heartbeat watches its mtime.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Goal, LoopCurrent, LoopRecord, LoopView } from '../types'
import { clip, evaluate } from './evaluator'
import type { StopFields } from './evaluator'
import { checkBash, checkPath, stripProse, uncommitted, WAIT_MAX_S, waitsLong } from './guard'
import { HOST_LOAD_HINT, hostLoadWait, WORKTREE_WAIT_HINT, worktreeRefs } from './plan'
import { markItem, nextPending, parseDuration, parseQueue, requeueItem, slugify, waitingItems } from './queue'
import type { QueueItem } from './queue'

export const DEFER_TOOL = 'defer_goal'
export const DEFER_TOOL_ID = 'mcp__auto-claude__defer_goal'
export const WAIT_TOOL = 'wait_until'
export const WAIT_TOOL_ID = 'mcp__auto-claude__wait_until'
// How long wait_until's own probe of `until` may run.
const WAIT_PROBE_MS = 30_000

const MAX_UNMET_PER_TURN = 5
const MAX_CHECKS = 30
const MAX_PARSE_FAILURES = 2
const BLOCK_CHARS = 2_000
export const LOOP_MAX_RETRIES = 2
export const LOOP_RETRY_DELAY_MS = 120_000
const KICKOFF_DELAY_MS = 1_000
const CHECK_TIMEOUT_MS = 600_000
// Failed checks a milestone needs before defer_goal is accepted: the
// deferAfterChecks option, 0 from 1.14.0 (it was a fixed 2). ImpossibleBench
// (arXiv 2510.20270) measured an always-available abort tool cutting GPT-5's
// hacking of contradictory tasks from 54% to 9%; a gate that makes the model
// fail twice first keeps it trying to make the check pass.
let deferAfter = 0
export function setDeferAfter(n: number): void {
  deferAfter = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}
export function deferAfterChecks(): number {
  return deferAfter
}

// Why a milestone is deferred. spec-ambiguous: the spec and the check (or the
// tests) contradict each other, so making the check pass would mean gaming it.
export const DEFER_CATEGORIES = ['credentials', 'payment', 'human-decision', 'access', 'spec-ambiguous'] as const
export type DeferCategory = (typeof DEFER_CATEGORIES)[number]

// The wording every prompt uses for when to defer.
export function deferRule(): string {
  const when = deferAfter === 0 ? 'at any point' : `after at least ${deferAfter} failed check(s)`
  return `For an external blocker (credentials, payment, a human decision, missing access) call ${DEFER_TOOL_ID} ${when}, with its category. When the spec and the check (or its tests) contradict each other, do not make the check pass: defer as spec-ambiguous and say what contradicts what.`
}
export const LOG_MAX_LINES = 2_000
export const LOOP_EXCLUDES = ['worktrees/', '.claude/goals.md', '.claude/goal-loop.log', '.claude/goal-loop.deny', '.claude/auto-activity.log']

export const goalAtom = atom({ plugin: 'auto-claude', key: 'goal' } as const, null, { shape: 'goal-1' })
export const viewAtom = atom({ plugin: 'auto-claude', key: 'view' } as const, null, { shape: 'view-1' })

// What the session is doing, for the watchdog: a goal whose session sits idle
// is not being built. Kept in memory; after a reload, `loadedAt` stands in
// for the last turn's end.
export const watch = {
  turnActive: false,
  lastTurnEndAt: undefined as number | undefined,
  // The Stop hook is running the check or the evaluator (up to ~11 min).
  judging: false,
  // A retry prompt is armed until then (loopStuck's pause).
  retryUntil: 0,
  loadedAt: 0,
  // Since when the last Stop left a workflow or subagent running in the
  // background: the session is waiting on it, not idle (see backgroundBusy).
  backgroundSince: undefined as number | undefined,
  // Since when Stops have found a background `git commit` running (commitInFlight).
  commitSince: undefined as number | undefined,
  // When the main turn running now began, and the session's last tool call in
  // any loop (a subagent's too): the status line's working/quiet (live.ts).
  turnSince: undefined as number | undefined,
  lastToolAt: undefined as number | undefined,
}

// Background work that wakes the session when it ends: a workflow (ultracode
// starts one for most tasks) or a subagent. A shell task is left out: a dev
// server never ends, and a milestone would never be judged.
const WAKING_TASKS: ReadonlySet<string> = new Set(['workflow', 'subagent', 'remote_agent', 'teammate'])
const LIVE_STATUS: ReadonlySet<string> = new Set(['running', 'pending'])
// Past this the run stops waiting on it: a hung workflow must not park the run.
export const BACKGROUND_MAX_MS = 2 * 60 * 60_000

// The waking work a Stop reports in flight (its `background_tasks`), described.
export function wakingWork(tasks: unknown): string[] {
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap(t => {
    const task = t as { type?: unknown; status?: unknown; description?: unknown; name?: unknown }
    if (!WAKING_TASKS.has(String(task.type)) || !LIVE_STATUS.has(String(task.status))) return []
    return [`${String(task.type)} ${String(task.name ?? task.description ?? '').slice(0, 80)}`.trim()]
  })
}

// A `git commit` still running as a background shell (1.18.0). A pre-commit hook
// that builds (cargo check in a fresh worktree) outlasts the Bash timeout, so
// the commit moves to the background with its changes staged. Judged then, the
// worktree reads as uncommitted at every Stop: de-artifact (2026-11-23 18:08Z)
// spent 13 checks in 3 min on it and blocked a milestone whose commit landed
// seconds later. Such a Stop is left unjudged; the commit's completion opens the
// next turn. A watcher whose command names `git commit` counts as well.
export function commitInFlight(tasks: unknown): boolean {
  if (!Array.isArray(tasks)) return false
  return tasks.some(t => {
    const task = t as { type?: unknown; status?: unknown; command?: unknown }
    return String(task.type) === 'shell' && LIVE_STATUS.has(String(task.status)) && /\bgit\b[^\n]*\bcommit\b/.test(String(task.command ?? ''))
  })
}

// A commit still running after this long (a hook that hangs) is judged as it stands.
export const COMMIT_WAIT_MS = 30 * 60_000

// The session waits on a background commit (commitInFlight) within its bound:
// not idle, so the watchdog does not wake it.
export function commitBusy(now: number): boolean {
  return watch.commitSince !== undefined && now - watch.commitSince < COMMIT_WAIT_MS
}

// Records what a main-thread Stop left running. Each such Stop restarts the
// clock: a turn that a workflow's result opened and that starts the next one
// is progress, and only a workflow that never reports back runs the ceiling out.
export function noteBackground(tasks: unknown, now: number): string[] {
  const work = wakingWork(tasks)
  watch.backgroundSince = work.length === 0 ? undefined : now
  return work
}

// The session waits on background work that will wake it, within the ceiling.
export function backgroundBusy(now: number): boolean {
  return watch.backgroundSince !== undefined && now - watch.backgroundSince < BACKGROUND_MAX_MS
}

// Called when a goal finishes, so the driver looks at once instead of at its next tick.
let onFinish: (() => void) | undefined
export function setOnFinish(f: (() => void) | undefined): void {
  onFinish = f
}

export type LogEvent = 'start' | 'resume' | 'unmet' | 'met' | 'retry' | 'blocked' | 'deferred' | 'denied' | 'queue-empty' | 'waiting' | 'error'

const loopKey = (root: string) => `loop:${root}`
export const queuePath = (root: string) => `${root}/.claude/goals.md`
export const logPath = (root: string) => `${root}/.claude/goal-loop.log`
const denyPath = (root: string) => `${root}/.claude/goal-loop.deny`

export async function readLoop($: EngineInterface, root: string): Promise<LoopRecord | undefined> {
  const value = await $.store.get(loopKey(root))
  return typeof value === 'object' && value !== null ? (value as LoopRecord) : undefined
}

export async function writeLoop($: EngineInterface, rec: LoopRecord): Promise<void> {
  await $.store.set(loopKey(rec.repoRoot), rec)
}

type ProcessResult = { exitCode: number; stdout: string; stderr: string }

async function run($: EngineInterface, argv: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  const result = await $.process.run(argv, { cwd, timeoutMs })
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

// The highest NN of the repository's goal/NN-* branches: a seq that starts
// below it (a store lost, goal-mode's own seq left behind) would make
// `worktree add -b` collide with a branch that exists.
export function maxBranchSeq(refs: string): number {
  let max = 0
  for (const line of refs.split('\n')) {
    const m = line.trim().match(/^goal\/(\d+)-/)
    if (m !== null) max = Math.max(max, Number(m[1]))
  }
  return max
}

// Takes the next pending queue line, makes its worktree from `base` (or the
// line's own `:: base:`), sets the goal and sends the kickoff. Undefined when
// the queue has no pending line (logged as queue-empty), when every pending
// line still waits on its `:: after:` (`ready`, the driver's polls), or when
// none could start.
export async function startNext($: EngineInterface, root: string, base: string, remote: string, ready?: (item: QueueItem) => boolean): Promise<LoopCurrent | undefined> {
  let rec: LoopRecord = (await readLoop($, root)) ?? { repoRoot: root, seq: 0, retries: 0 }
  if (rec.current !== undefined) return rec.current
  const refs = await run($, ['git', '-C', root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/goal/'], root, 15_000).catch(() => undefined)
  rec = { ...rec, seq: Math.max(rec.seq, maxBranchSeq(refs?.stdout ?? '')) }
  for (let attempt = 0; attempt < 5; attempt++) {
    const items = parseQueue((await readText($, queuePath(root))) ?? '')
    const item = nextPending(items, ready)
    if (item === undefined) {
      await writeLoop($, { ...rec, current: undefined, retries: 0 })
      // Lines still waiting: the queue is not empty, and the driver polls them.
      if (waitingItems(items, ready ?? (i => i.after === undefined)).length === 0) await appendLog($, root, { event: 'queue-empty' })
      return undefined
    }
    const seq = rec.seq + 1
    const name = `${String(seq).padStart(2, '0')}-${slugify(item.condition)}`
    const worktree = `${root}/worktrees/goal-${name}`
    const branch = `goal/${name}`
    rec = { ...rec, seq }
    const from = item.base ?? base
    // A remote base is fetched first, so the worktree starts from what was merged.
    if (remote !== '.' && from.startsWith(`${remote}/`)) await run($, ['git', '-C', root, 'fetch', '-q', remote], root, 60_000).catch(() => undefined)
    const made = await run($, ['git', '-C', root, 'worktree', 'add', worktree, '-b', branch, from], root, 60_000).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
    if (made.exitCode !== 0) {
      const why = clip(made.stderr.trim() || made.stdout.trim() || 'git worktree add failed', 300)
      await markQueue($, root, item.condition, '!', `blocked ${isoNow()}: could not create worktree: ${why}`)
      await appendLog($, root, { event: 'error', goal: item.condition, reason: why })
      await writeLoop($, rec)
      continue
    }
    const current: LoopCurrent = { condition: item.condition, check: item.check, worktree, branch, startedAt: await $.clock.now() }
    rec = { ...rec, current, retries: 0, wakes: 0 }
    await writeLoop($, rec)
    await setView($, root, current)
    await update($, goalAtom, () => newGoal(item.condition, item.check, current.startedAt))
    await appendLog($, root, { event: 'start', goal: item.condition, worktree, branch })
    submitLater($, root, kickoffText(current, seq), KICKOFF_DELAY_MS)
    return current
  }
  await $.ui.toast('auto-claude: could not start any milestone (worktree errors); see .claude/goal-loop.log')
  return undefined
}

// Sends the current goal's prompt again: a resumed session, or a session the
// watchdog found idle with a goal still open.
export async function resumeLoop($: EngineInterface, root: string, why: string): Promise<boolean> {
  const rec = await readLoop($, root)
  const current = rec?.current
  if (rec === undefined || current === undefined) return false
  await setView($, root, current)
  const goal = await read($, goalAtom)
  if (goal === null || goal.condition !== current.condition) {
    await update($, goalAtom, () => newGoal(current.condition, current.check, current.startedAt))
  } else {
    await update($, goalAtom, g => (g === null ? null : resetTurn(g)))
  }
  await appendLog($, root, { event: 'resume', goal: current.condition, reason: why })
  submitLater($, root, `[auto-claude loop] Continuing (${why}).\n\n${kickoffText(current, rec.seq)}`, KICKOFF_DELAY_MS)
  return true
}

// The milestone being built in this session, for the guards and the policy;
// null when none. (The engine reads state only through atoms of the same file.)
export async function loopView($: EngineInterface): Promise<LoopView | null> {
  return read($, viewAtom)
}

// Ends the loop's part of a run: no goal judged, no guards. The milestone
// being built stays open, so a resume picks it up where it was (dropping it
// left the run counting a start that never ended, and waiting on it forever);
// `drop` forgets it, for a new run. Its worktree and branch stay either way.
export async function stopLoop($: EngineInterface, root: string, drop = false): Promise<void> {
  const rec = await readLoop($, root)
  if (rec !== undefined && drop) await writeLoop($, { ...rec, current: undefined, retries: 0, wakes: 0 })
  await update($, goalAtom, () => null)
  await update($, viewAtom, () => null)
}

async function setView($: EngineInterface, root: string, current: LoopCurrent): Promise<void> {
  const view: LoopView = { repoRoot: root, worktree: current.worktree, branch: current.branch, extraDeny: await readDenyFile($, root) }
  await update($, viewAtom, () => view as never)
}

// A prompt submitted from inside a hook that holds the turn (command.run,
// classic.Stop) is refused by the engine: a timer fires after the hook
// returned, and the prompt starts a turn of its own once the session is idle.
function submitLater($: EngineInterface, root: string, text: string, delayMs: number): void {
  $.clock.after(delayMs, () => {
    $.prompt.submit({ text }).catch(async error => {
      await appendLog($, root, { event: 'error', reason: `prompt not submitted: ${clip(String(error), 300)}` })
      $.ui.toast('auto-claude: a loop prompt could not be submitted; the watchdog sends it again')
    })
  })
}

// The Stop of a turn in which a goal runs: judge it.
export async function onStop<R extends { block?: string }>($: EngineInterface, e: StopFields, below: R): Promise<R> {
  // The commit wait (commitInFlight) holds only while a Stop still sees the commit running.
  const now = await $.clock.now()
  if (!commitInFlight((e as { background_tasks?: unknown }).background_tasks)) watch.commitSince = undefined
  else watch.commitSince ??= now
  const goal = await read($, goalAtom)
  if (goal === null) return below
  const view = await read($, viewAtom)
  const rec = view === null ? undefined : await readLoop($, view.repoRoot)
  if (view === null || rec?.current === undefined) {
    // The run was stopped elsewhere: drop the orphan goal.
    await update($, goalAtom, () => null)
    await update($, viewAtom, () => null)
    return below
  }
  watch.judging = true
  try {
    return await judge($, { rec, view, goal }, e, below)
  } finally {
    watch.judging = false
  }
}

async function judge<R extends { block?: string }>($: EngineInterface, { rec, view, goal }: { rec: LoopRecord; view: LoopView; goal: Goal }, e: StopFields, below: R): Promise<R> {
  // The turn ended with a workflow or subagent still running: its result opens
  // the next turn, and that turn's Stop is judged. No check runs or counts now,
  // and a wait or deferral asked for meanwhile is applied then, so the next
  // milestone never starts under a workflow still working on this one.
  if (backgroundBusy(await $.clock.now())) {
    await appendLog($, view.repoRoot, { event: 'background', goal: rec.current?.condition.slice(0, 80) })
    return below
  }
  if (goal.deferPending !== undefined) {
    const category = goal.deferCategory ?? 'human-decision'
    await finishGoal($, rec, { mark: '!', note: `deferred ${isoNow()} (${category}): ${goal.deferPending}`, event: 'deferred', reason: goal.deferPending, extra: { category, checks: goal.checks } })
    return below
  }
  if (goal.waitPending !== undefined) {
    await finishWait($, rec, goal.waitPending)
    return below
  }

  // 0. A commit still running in the background (commitInFlight) with the
  // worktree not yet clean: nothing is run or counted until it lands, so the
  // check does not race the commit's own hook either.
  if (watch.commitSince !== undefined && (await $.clock.now()) - watch.commitSince < COMMIT_WAIT_MS) {
    const dirty = await run($, ['git', '-C', view.worktree, 'status', '--porcelain'], view.worktree, 60_000).catch(() => undefined)
    if (dirty !== undefined && uncommitted(dirty.stdout).length > 0) {
      await appendLog($, view.repoRoot, { event: 'commit-in-flight', goal: goal.condition.slice(0, 80) })
      return below
    }
    watch.commitSince = undefined
  }

  // 1. The queue's own check, run deterministically in the worktree.
  let evidence: string | undefined
  if (goal.check !== undefined) {
    let ran: ProcessResult
    try {
      ran = await run($, ['bash', '-lc', goal.check], view.worktree, CHECK_TIMEOUT_MS)
    } catch (error) {
      return loopStuck($, rec, goal, below, `the check could not run (${clip(String(error), 200)})`)
    }
    const output = clip(`${ran.stdout}\n${ran.stderr}`.trim(), 1_500, true)
    if (ran.exitCode !== 0) return loopUnmet($, rec, goal, below, `check \`${goal.check}\` exited ${ran.exitCode}:\n${output}`)
    evidence = `The loop ran the check \`${goal.check}\` in ${view.worktree}: exit 0.\n${output}`
  }

  // 2. Every step must be committed before the goal can count as met.
  const status = await run($, ['git', '-C', view.worktree, 'status', '--porcelain'], view.worktree, 60_000).catch(() => undefined)
  const pending = status === undefined ? [] : uncommitted(status.stdout)
  if (pending.length > 0) return loopUnmet($, rec, goal, below, `uncommitted changes in ${view.worktree}; commit them:\n${clip(pending.join('\n'), 600)}`)

  // 3. The independent judge, given the check's result as evidence.
  const verdict = await evaluate($, goal, e, evidence)
  if (verdict.kind === 'met') {
    await finishGoal($, rec, { mark: 'x', note: `done ${isoNow()} ${view.branch}, ${goal.checks} failed checks`, event: 'met', reason: verdict.reason })
    return below
  }
  if (verdict.kind === 'unmet') return loopUnmet($, rec, goal, below, verdict.reason)
  if (verdict.kind === 'failed') return loopStuck($, rec, goal, below, `the goal check could not complete (${verdict.reason})`)
  const failures = goal.parseFailures + 1
  if (failures >= MAX_PARSE_FAILURES) return loopStuck($, rec, goal, below, 'the goal check gave no readable verdict')
  await update($, goalAtom, g => (g === null ? null : { ...g, parseFailures: failures }))
  return below
}

async function loopUnmet<R extends { block?: string }>($: EngineInterface, rec: LoopRecord, goal: Goal, below: R, reason: string): Promise<R> {
  const counted = await countUnmet($, reason)
  await appendLog($, rec.repoRoot, { event: 'unmet', goal: goal.condition, reason: clip(reason, 300), checks: counted.checks })
  if (counted.checks >= MAX_CHECKS) {
    await finishGoal($, rec, { mark: '!', note: `blocked ${isoNow()}: unmet after ${counted.checks} checks: ${clip(reason, 200)}`, event: 'blocked', reason: reason })
    return below
  }
  if (counted.unmetThisTurn >= MAX_UNMET_PER_TURN) return loopStuck($, rec, goal, below, 'goal checks kept finding it unmet this turn')
  return { ...below, block: blockText(reason, goal) }
}

// Stuck: retry with a change of approach after a pause, then give up on the
// goal and move on. The stop itself is allowed either way.
export async function loopStuck<R>($: EngineInterface, rec: LoopRecord, goal: Goal, below: R, because: string): Promise<R> {
  if (rec.retries >= LOOP_MAX_RETRIES || rec.current === undefined) {
    const last = goal.lastReason ?? because
    await finishGoal($, rec, { mark: '!', note: `blocked ${isoNow()}: ${clip(last, 200)}`, event: 'blocked', reason: last })
    return below
  }
  const retries = rec.retries + 1
  await writeLoop($, { ...rec, retries })
  await update($, goalAtom, g => (g === null ? null : resetTurn(g)))
  await appendLog($, rec.repoRoot, { event: 'retry', goal: goal.condition, reason: because, retries })
  watch.retryUntil = (await $.clock.now()) + LOOP_RETRY_DELAY_MS + 5_000
  const reasons = (await read($, goalAtom))?.recentReasons ?? []
  submitLater($, rec.repoRoot, retryText(rec.current, retries, reasons), LOOP_RETRY_DELAY_MS)
  return below
}

// Gives up on the current goal from outside a Stop (the watchdog woke an idle
// session too often): blocked, and the driver moves on.
export async function blockCurrent($: EngineInterface, root: string, why: string): Promise<void> {
  const rec = await readLoop($, root)
  if (rec?.current === undefined) return
  await finishGoal($, rec, { mark: '!', note: `blocked ${isoNow()}: ${clip(why, 200)}`, event: 'blocked', reason: why })
}

// Marks the queue line and logs; the driver reads the event and ships, holds
// or starts the next goal. The worktree and branch stay.
type Outcome = { mark: 'x' | '!'; note: string; event: LogEvent; reason: string; extra?: Record<string, unknown> }

async function finishGoal($: EngineInterface, rec: LoopRecord, { mark, note, event, reason, extra }: Outcome): Promise<void> {
  const current = rec.current
  if (current === undefined) return
  await markQueue($, rec.repoRoot, current.condition, mark, note)
  await appendLog($, rec.repoRoot, { event, goal: current.condition, reason: clip(reason, 300), branch: current.branch, ...(extra ?? {}) })
  $.ui.toast(`auto-claude: milestone ${mark === 'x' ? 'met' : event}: ${clip(current.condition, 80)}`)
  await update($, goalAtom, () => null)
  await update($, viewAtom, () => null)
  await writeLoop($, { ...rec, current: undefined, retries: 0, wakes: 0 })
  onFinish?.()
}

// wait_until applied: the line goes back to the queue, waiting on its
// command, and restarts from the branch built so far once that passes. The
// session is free for other lines meanwhile.
async function finishWait($: EngineInterface, rec: LoopRecord, wait: NonNullable<Goal['waitPending']>): Promise<void> {
  const current = rec.current
  if (current === undefined) return
  const text = await readText($, queuePath(rec.repoRoot))
  if (text !== undefined) {
    await $.fs.write(queuePath(rec.repoRoot), requeueItem(text, current.condition, wait, current.branch, `waiting since ${isoNow()}: ${wait.reason}`)).catch(() => undefined)
  }
  await appendLog($, rec.repoRoot, { event: 'waiting', goal: current.condition, reason: clip(wait.reason, 300), branch: current.branch, after: wait.after })
  $.ui.toast(`auto-claude: milestone waits on \`${clip(wait.after, 60)}\`: ${clip(current.condition, 60)}`)
  await update($, goalAtom, () => null)
  await update($, viewAtom, () => null)
  await writeLoop($, { ...rec, current: undefined, retries: 0, wakes: 0 })
  onFinish?.()
}

// wait_until: the milestone needs something with its own clock (a training
// run, a cache build, a file another milestone lands). Recorded only; the next
// Stop puts the line back to wait, so the driver, not the model, watches it.
export async function waitCall($: EngineInterface, input: Record<string, unknown>): Promise<{ deny: string } | { result: string }> {
  const text = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '')
  const until = text('until')
  const alive = text('alive')
  const within = text('within')
  const reason = text('reason')
  const goal = await read($, goalAtom)
  const view = await read($, viewAtom)
  if (goal === null || view === null) return { deny: `${WAIT_TOOL_ID} is only for milestones of a running auto-claude loop.` }
  if (until === '') return { deny: 'until is required: a shell command that exits 0 once what you wait for is done (e.g. grep -q "DONE" ~/data/x/cache.log).' }
  if (reason === '') return { deny: 'reason is required.' }
  const refs = worktreeRefs(`${until} ${alive}`)
  if (refs.length > 0) return { deny: `${refs[0]} will not be there when this is polled: ${WORKTREE_WAIT_HINT}.` }
  if (hostLoadWait(`${until} ${alive}`)) return { deny: `A wait on the host's load or uptime may never pass: ${HOST_LOAD_HINT}.` }
  if (within !== '' && parseDuration(within) === undefined) return { deny: `within must be a duration like 90m, 12h or 2d, not "${within}".` }
  // Run where the driver polls it: the repository root (the worktree may be gone by then).
  const probe = await run($, ['bash', '-lc', until], view.repoRoot, WAIT_PROBE_MS).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
  if (probe.exitCode === 0) return { deny: `\`${until}\` already exits 0: what it waits for is done. Keep working on the milestone.` }
  const status = await run($, ['git', '-C', view.worktree, 'status', '--porcelain'], view.worktree, 60_000).catch(() => undefined)
  const dirty = status === undefined ? [] : uncommitted(status.stdout)
  if (dirty.length > 0) return { deny: `Commit your work first: the milestone restarts from ${view.branch} once the wait is over.\n${clip(dirty.join('\n'), 400)}` }
  await update($, goalAtom, g => (g === null ? null : { ...g, waitPending: { after: until, ...(alive !== '' ? { alive } : {}), ...(within !== '' ? { within } : {}), reason } }))
  return { result: `Wait recorded. End the turn now. auto-claude polls \`${clip(until, 120)}\` every few minutes and restarts this milestone from ${view.branch} when it exits 0; other milestones go on meanwhile.${alive !== '' ? ' If the alive command fails, you are asked to look.' : ''}` }
}

// defer_goal: recorded only; the next Stop marks the goal and moves on, so a
// new goal is never judged against this turn's transcript.
export async function deferCall($: EngineInterface, reasonRaw: unknown, categoryRaw?: unknown): Promise<{ deny: string } | { result: string }> {
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : ''
  const goal = await read($, goalAtom)
  if (goal === null || (await read($, viewAtom)) === null) return { deny: `${DEFER_TOOL_ID} is only for milestones of a running auto-claude loop.` }
  if (goal.checks < deferAfter) {
    return { deny: `Too early to defer: only ${goal.checks} failed check(s). Keep working; defer only an external blocker after ${deferAfter} failed checks.` }
  }
  if (reason === '') return { deny: 'reason is required.' }
  if (!(DEFER_CATEGORIES as readonly unknown[]).includes(categoryRaw)) return { deny: `category is required: one of ${DEFER_CATEGORIES.join(', ')}.` }
  const category = categoryRaw as DeferCategory
  await update($, goalAtom, g => (g === null ? null : { ...g, deferPending: reason, deferCategory: category }))
  return { result: 'Deferral recorded. Stop now; the loop marks this milestone blocked and moves to the next one.' }
}

// Refusals while a run is on in this session (`runOn`) and while a goal runs
// in it (`view`). The person cannot answer, a plan-mode turn would hold the
// run, and a session goal of Claude Code's own (/goal) would block the loop's
// stops (measured in de-artifact: the run idled to its 24 h cap).
// A run never rests inside a turn either: auto-claude watches CI, merges and
// deploys itself, and wakes the session when it has work for it.
const WAIT_TOOLS: ReadonlySet<string> = new Set(['CronCreate', 'ScheduleWakeup', 'Monitor'])
const WAIT_REFUSAL = `auto-claude run: do not wait or schedule a wake-up inside a turn. auto-claude watches CI, merges and deploys by itself. To wait on a training run, a cache build or another job, call ${WAIT_TOOL_ID} with a shell command that exits 0 once it is done, then end the turn: the driver polls it and prompts this session again. Otherwise keep working on the milestone, or end the turn if it is done (sleeps under ${WAIT_MAX_S} s are fine).`

export function guardRefusal(e: Record<string, unknown>, view: LoopView | null, runOn: boolean): string | undefined {
  const tool = String(e.tool)
  const agent = e.agentId !== undefined
  if (agent && (runOn || view !== null)) {
    if (WAIT_TOOLS.has(tool) || (tool === 'Bash' && typeof e.command === 'string' && waitsLong(e.command))) return AGENT_PARKS
  }
  // A workflow agent's shell starts in the session's directory, which may be
  // the main checkout: its git writes must name the worktree.
  if (agent && view !== null && tool === 'Bash' && typeof e.command === 'string' && GIT_WRITE.test(stripProse(e.command)) && !e.command.includes(view.worktree)) {
    return `auto-claude milestone: a workflow agent runs git writes in the worktree only: cd ${view.worktree} && <command>, or git -C ${view.worktree} <command>. Committing is the main thread's job.`
  }
  if (runOn || view !== null) {
    if (tool === 'AskUserQuestion') return `auto-claude run: nobody can answer. Decide with a stated assumption (the recommended or safest option), or call ${DEFER_TOOL_ID} for an external blocker.`
    if (tool === 'EnterPlanMode') return 'auto-claude run: plan mode would hold the run; plan inline and keep working.'
    if (tool === 'ProposeGoal' || tool === 'mcp__goal-mode__set_goal') return 'auto-claude run: the loop sets each milestone as the goal itself; a session goal would block it.'
    if (WAIT_TOOLS.has(tool) || (tool === 'Bash' && typeof e.command === 'string' && waitsLong(e.command))) return WAIT_REFUSAL
    // Typed into the session's own terminal (tmux send-keys), the command would
    // reach the plugin as the person's own (composer origin) and pass its check.
    if (tool === 'Bash' && typeof e.command === 'string' && /auto-claude\s+approve\b/.test(e.command)) return 'auto-claude run: /auto-claude approve is the person\'s word alone; tell them the PR waits for it, and never send it yourself.'
  }
  if (view === null) return undefined
  if (tool === 'Bash' && typeof e.command === 'string') return checkBash(e.command, view)
  if ((tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') && typeof e.file_path === 'string') return checkPath(e.file_path, view)
  if (tool === 'NotebookEdit' && typeof e.notebook_path === 'string') return checkPath(e.notebook_path, view)
  return undefined
}

// Git commands that change a checkout or its history.
// The subcommand right after `git` and its global options, so `git diff -- add.py` is a read.
const GIT_WRITE = /\bgit(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+(commit|add|checkout|switch|merge|rebase|stash|restore|cherry-pick|am|apply|reset|rm|mv)\b/

// What a workflow agent is told when it would wait or park the milestone: that is the main thread's call.
export const AGENT_PARKS = `auto-claude run: a workflow agent does not wait or park the milestone. Finish with what you have and return what is still pending (the job, how to check it) to the main thread; it calls ${WAIT_TOOL_ID} or ${DEFER_TOOL_ID}.`

// Ultracode runs workflows: their agents must keep to the milestone's worktree.
export const WORKFLOW_RULE = "Workflows and subagents: give every agent the milestone's worktree path and have it work there, with no isolation: 'worktree' (an agent's edits or git writes elsewhere are refused). Agents neither commit nor wait: you commit their work, and a job still running comes back to you for the wait tool. Ending the turn while a workflow runs is fine: the milestone is judged at the Stop of the turn its result opens."

export const loopPolicy = (): string => `# auto-claude milestone — ACTIVE
You are building one milestone of an unattended auto-claude run. Nobody is watching this session.
- Do not ask questions (AskUserQuestion is refused) and do not enter plan mode. Decide with a stated assumption and record it in the commit message.
- A "CONFIDENCE HALT" becomes a call to ${DEFER_TOOL_ID} with the reason and its category. ${deferRule()} Otherwise keep working.
- Waiting on compute (a training run, a cache build, a job you launched, a file another milestone lands) is not a blocker: commit, call ${WAIT_TOOL_ID} with a shell command that exits 0 once it is done (and an alive command that fails if the job died), then end the turn. Never defer for it.
- Work only inside the milestone's worktree; commit after each meaningful step. Push only your goal/* branch, never main or with force. auto-claude pushes, merges and deploys for you.
- Never wait inside a turn (no long sleep, CI watch, Monitor, cron or scheduled wake-up); ${WAIT_TOOL_ID} is how a milestone waits. While an earlier milestone's CI runs you are already building the next one; when this one is done, end the turn and the next prompt comes by itself.
- ${WORKFLOW_RULE}`

export function kickoffText(current: LoopCurrent, seq: number): string {
  return [
    `[auto-claude loop] Milestone #${seq}: ${current.condition}`,
    current.check
      ? `Check (the loop runs it in the worktree at every stop; it must exit 0): ${current.check}`
      : 'No check command: an independent evaluator judges the milestone from the transcript, so leave real evidence.',
    `Work ONLY in the git worktree ${current.worktree} (branch ${current.branch}); cd there first. Edits elsewhere in the repository are refused.`,
    'Commit after each meaningful step: the milestone is not accepted with uncommitted changes.',
    `You may push only this branch (git push -u origin ${current.branch}); never main/master, never with force. auto-claude opens the PR, merges and deploys once the milestone is met.`,
    `Nobody is watching: do not ask questions. Decide with a stated assumption and record it in the commit message. ${deferRule()}`,
    `If it needs a job to finish first (training, a cache build), launch or check the job, commit, and call ${WAIT_TOOL_ID} with a shell command that exits 0 once it is done; auto-claude polls it and resumes this milestone.`,
    WORKFLOW_RULE.replace("the milestone's worktree path", `the worktree path ${current.worktree}`),
  ].join('\n')
}

function retryText(current: LoopCurrent, retries: number, reasons: readonly string[]): string {
  return [
    `[auto-claude loop] Retry ${retries}/${LOOP_MAX_RETRIES} for: ${current.condition}`,
    'The last checks found it unmet:',
    ...reasons.map(reason => `- ${clip(reason, 400)}`),
    `Step back: list the approaches you have tried and why they failed, then pick a materially different approach (a subagent may investigate). Continue in ${current.worktree} on ${current.branch}.`,
  ].join('\n')
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function markQueue($: EngineInterface, root: string, condition: string, mark: 'x' | '!', note: string): Promise<void> {
  const text = await readText($, queuePath(root))
  // The queue file vanished: the log still records the outcome.
  if (text !== undefined) await $.fs.write(queuePath(root), markItem(text, condition, mark, note)).catch(() => undefined)
}

async function readDenyFile($: EngineInterface, root: string): Promise<string[]> {
  return ((await readText($, denyPath(root))) ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
}

// Appends run one after another: each reads and rewrites the whole file, so
// two at once in this process (the Stop hook's and the driver tick's) lost
// one of the lines (measured in 1.11.0's tests: the loop's met line).
export function serial(): <T>(job: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job)
    chain = next.catch(() => undefined)
    return next
  }
}

const logQueue = serial()

export function appendLog($: EngineInterface, root: string, entry: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: isoNow(), ...entry })
  return logQueue(async () => {
    try {
      const text = (await readText($, logPath(root))) ?? ''
      const lines = text.split('\n').filter(l => l !== '')
      lines.push(line)
      await $.fs.write(logPath(root), `${lines.slice(-LOG_MAX_LINES).join('\n')}\n`)
    } catch {
      // Logging never stops the loop.
    }
  })
}

function newGoal(condition: string, check: string | undefined, setAt: number): Goal {
  return { condition, check, setAt, checks: 0, unmetThisTurn: 0, parseFailures: 0, recentReasons: [] }
}

function resetTurn(goal: Goal): Goal {
  return { ...goal, unmetThisTurn: 0, parseFailures: 0 }
}

async function countUnmet($: EngineInterface, reason: string): Promise<{ checks: number; unmetThisTurn: number }> {
  const goal = await update($, goalAtom, g =>
    g === null ? null : { ...g, checks: g.checks + 1, unmetThisTurn: g.unmetThisTurn + 1, lastReason: reason, recentReasons: [...g.recentReasons, reason].slice(-3) },
  )
  return { checks: goal?.checks ?? 0, unmetThisTurn: goal?.unmetThisTurn ?? 0 }
}

function blockText(reason: string, goal: Goal): string {
  return clip(
    `Milestone not met: ${reason}\nKeep working toward it: ${goal.condition}${goal.check ? `\nCheck: ${goal.check}` : ''}\nRe-run the check before you stop so its output is in the transcript.`,
    BLOCK_CHARS,
  )
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}
