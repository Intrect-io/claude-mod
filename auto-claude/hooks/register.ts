import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AutoRecord, ShipItem, WaitState } from '../types'
import { deployFixLine, finalCheckOf, fixLine, kickoffText, parseQueue, planNudgeText, POLICY, READY_TOOL, replanText, validatePlan } from './plan'
import { segment } from './segment'
import { DEPLOY_FILE, parseDeploy, specOfPlan } from './deploy'
import type { DeploySpec } from './deploy'
import { deployMerged } from './deploy-run'
import { bootstrapRepo } from './bootstrap'
import { ensureLines, FILES, fetchRemote, LOCAL, out, readText, refOf, repoRoot, run, tell } from './io'
import { appendLog, blockCurrent, DEFER_TOOL, DEFER_TOOL_ID, deferCall, WAIT_TOOL, WAIT_TOOL_ID, waitCall, guardRefusal, LOOP_EXCLUDES, LOOP_POLICY, loopView, MIN_CHECKS_TO_DEFER, onStop, readLoop, resumeLoop, setOnFinish, startNext, stopLoop, watch, writeLoop } from './loop'
import { capReached, causeOf, ciAction, diagnose, httpsOf, idleDue, inFlight, isWaiting, onlyWaiting, LOOP_WAKES, MAX_IDLE_NUDGES, MAX_RED, mergeable, noRequired, onlyCancelled, parseChecks, prNumber, progressSig, readLog, repoSlug, shipRemedy, startBase, summary, unfinished, wakeDue } from './ship'
import { markItem, nextPending, waitingItems } from './queue'
import type { QueueItem } from './queue'
import { baseline, getIssue, isOpen, lineIssues, onHeld, onMerged, onStart, projectOf, readChanges, SYNC_MS } from './linear'
import type { StallFacts } from './ship'
import type { Caps } from './ship'
import { COMPACT_PERCENT, cycleLine, dayCapHit, dueSources, eventLines, HEALTH_FAILS, lineGhIssues, nextTimers, pollGithub, pollHealth, recentMerges, sourcesOf, WAKE_QUIET_MS, withCycle } from './standby'
import type { StandbyConfig } from './standby'

// auto-claude: an unattended run of one repository. Claude plans the
// long-term end state and its milestones (.claude/auto-plan.md,
// .claude/goals.md, with how the run deploys); the loop (loop.ts) builds each
// milestone in its own worktree and judges it; this module ships it (push, PR,
// CI, merge when green, deploy and smoke check), one at a time, and replans
// when the queue empties before the final check passes. Shipping and
// deploying run here, through $.process.run, never as a model turn, and the
// model is denied merging and deploying. A watchdog keeps the run moving:
// what it can fix it fixes, what needs the model it prompts the model with,
// and what stays stuck it holds and goes past. goal-mode, which used to own
// the loop, merged into this plugin in 1.0.0. The session never rests while
// work is queued: during a PR's CI the next milestones are built on its
// branch (stacked), then rebased onto the default branch once it lands.

const COMMAND = 'auto-claude'
// The ready tool's full name, as the tool.call matcher sees it.
const READY_TOOL_ID = 'mcp__auto-claude__auto_plan_ready'
const STORE = (root: string) => `auto:${root}`
const EXCLUDES = ['.claude/auto-plan.md', '.claude/auto-claude.stop', '.claude/auto-claude.stop.cleared', '.claude/auto-claude.on', ...LOOP_EXCLUDES]
const DENY = ['\\bgh\\s+pr\\s+merge\\b', '\\bgh\\s+release\\b', '\\bgit\\s+push\\b.*\\bHEAD:(main|master)\\b']

// A run whose owning session has not ticked for this long is orphaned.
const STALE_MS = 10 * 60_000
// A run still planning is reminded this long after the model's turn ended
// without accepting a plan, else after PLAN_NUDGE_MS; this many times, then stopped.
const PLAN_QUIET_MS = 60_000
const PLAN_NUDGE_MS = 15 * 60_000
const MAX_NUDGES = 3
// While a PR's CI is pending it is looked at this often, between the ticks.
const CI_FAST_MS = 10_000
// Ready steps one tick takes a milestone through (push, PR, CI, landing).
const MAX_STEPS = 4
// A PR that reports no checks yet may only be slow to register them: it is
// waited on this long before "no checks" means the repository has no CI.
const NO_CI_GRACE_MS = 90_000
// Deploys failing in a row before the run stops: what is live stays broken.
const MAX_DEPLOY_FAILS = 3
// Milestones held in a row for one cause before the run stops (ship.ts causeOf).
const MAX_HOLD_STREAK = 2
// A waiting line's `:: after:` is run this often, each run cut off after
// WAIT_PROBE_MS; `:: alive:` failing this many polls in a row means the job
// it waits for died.
const WAIT_POLL_MS = 3 * 60_000
const WAIT_PROBE_MS = 30_000
const ALIVE_FAILS = 2
// A wait with no `within` of its own still goes to the model after this long,
// so a job that died without an alive check is not waited on in silence.
const WAIT_ASK_MS = 12 * 3_600_000

let ticker: Timer | undefined
let ticking = false
// A fast look at a pending CI is already scheduled.
let fastTick = false
let activeRoot: string | undefined
// The owner an orphaned run was last reported for, once per session.
let orphanTold: string | undefined
// Ticks failed in a row and the last error: a tick that throws every time
// (an unwritable file, a broken store) moves nothing and must not stay silent.
let tickFails = 0
let tickError: string | undefined
const TICK_FAIL_TELL = 3
// Set by register from the plugin's options: how an always-on run polls in standby.
let standbyCfg: StandbyConfig = { healthMs: 30 * 60_000, githubMs: 10 * 60_000, issueLabel: 'auto-claude', maxMergesPerDay: 20 }

async function readRecord($: EngineInterface, root: string): Promise<AutoRecord | undefined> {
  const v = await $.store.get(STORE(root))
  return typeof v === 'object' && v !== null ? (v as AutoRecord) : undefined
}

async function writeRecord($: EngineInterface, r: AutoRecord): Promise<void> {
  await $.store.set(STORE(r.root), r)
  // Other plugins cannot read this store: this file tells them a run owns the
  // repository.
  // A run standing by owns nothing: the person may work in the repository meanwhile.
  await $.fs.write(`${r.root}/.claude/auto-claude.on`, `${JSON.stringify({ on: owns(r), phase: r.phase, at: await $.clock.now() })}\n`).catch(() => undefined)
  await show($, r)
}

// The run holds the session and the repository: on, and not standing by
// between cycles. Its guards and its unattended policy apply only then.
const owns = (r: Pick<AutoRecord, 'on' | 'phase'> | undefined): boolean => r?.on === true && r.phase !== 'standby'

// Issue IDs of queue lines not started yet, and of the milestones being built or shipped.
async function linearSets($: EngineInterface, r: AutoRecord): Promise<{ pending: Set<string>; active: Set<string> }> {
  const current = (await readLoop($, r.root))?.current?.condition
  const queue = parseQueue((await readText($, FILES(r.root).queue)) ?? '')
  const pending = new Set(queue.filter(i => i.mark === ' ' && i.condition !== current).flatMap(i => lineIssues(i.condition)))
  const active = new Set([...(current === undefined ? [] : lineIssues(current)), ...r.ships.filter(s => s.state !== 'merged' && s.state !== 'held').flatMap(s => lineIssues(s.goal))])
  return { pending, active }
}

// Linear changes since the last look become queue lines; `force` skips the timer.
// A run started before this version (or before its repo was mapped) adopts the
// project here, covered from now on.
async function linearSync($: EngineInterface, r: AutoRecord, force = false): Promise<{ r: AutoRecord; added: number }> {
  if (r.buildOnly === true || (r.phase !== 'run' && r.phase !== 'standby')) return { r, added: 0 }
  const now = await $.clock.now()
  if (r.linear === undefined) {
    const project = await projectOf($, r.root)
    if (project === undefined) return { r, added: 0 }
    const got = await baseline($, project, now)
    await tell($, r, `Linear: syncing project ${project} from now on`)
    return { r: { ...r, linear: got.sync }, added: 0 }
  }
  if (!force && now - (r.linear.syncedAt ?? 0) < SYNC_MS) return { r, added: 0 }
  const sets = await linearSets($, r)
  const queue = parseQueue((await readText($, FILES(r.root).queue)) ?? '')
  const runIds = new Set(queue.flatMap(i => lineIssues(i.condition)))
  const got = await readChanges($, r.linear, sets.pending, sets.active, now, runIds)
  // A line whose issue was closed while it waited is blocked, not built.
  if (got.open !== undefined) {
    for (const id of sets.pending) {
      if (got.open.has(id)) continue
      const issue = await getIssue($, id).catch(() => undefined)
      if (issue === undefined || isOpen(issue)) continue
      const text = (await readText($, FILES(r.root).queue)) ?? ''
      let marked = text
      for (const item of parseQueue(text)) {
        if (item.mark === ' ' && lineIssues(item.condition).includes(id)) marked = markItem(marked, item.condition, '!', `Linear ${id} was closed (${issue.status ?? issue.statusType ?? 'closed'}) before this was built`)
      }
      if (marked !== text) {
        await $.fs.write(FILES(r.root).queue, marked)
        await tell($, r, `Linear ${id} was closed; its pending milestone is blocked`)
      }
    }
  }
  for (const line of got.lines) await appendQueue($, r.root, line)
  if (got.lines.length > 0) await tell($, r, `Linear: ${got.lines.length} changed issue(s) queued as milestones`)
  // A failing sync is told once, when it starts failing.
  if (got.sync.error !== undefined && r.linear.error === undefined) await tell($, r, `Linear sync failed: ${got.sync.error}; retried every ${SYNC_MS / 60_000} min`)
  return { r: { ...r, linear: got.sync }, added: got.lines.length }
}

// The planning prompt's Linear part, with the run's sync started from what it shows.
async function linearKickoff($: EngineInterface, root: string): Promise<{ linear?: AutoRecord['linear']; brief?: string }> {
  const project = await projectOf($, root)
  if (project === undefined) return {}
  const got = await baseline($, project, await $.clock.now())
  return { linear: got.sync, brief: got.brief }
}

async function show($: EngineInterface, r: AutoRecord | undefined) {
  if (r === undefined || !r.on) {
    await segment($, r?.phase === 'done' ? 'auto·done' : '')
    return
  }
  let total = 0
  let done = 0
  const queue = await readText($, FILES(r.root).queue)
  if (queue !== undefined) {
    const items = parseQueue(queue)
    total = items.length
    done = items.filter(i => i.mark !== ' ').length
  }
  if (r.phase === 'standby') {
    await segment($, `auto·standby·c${r.cycle ?? 0}`)
    return
  }
  const pr = inFlight(r.ships)?.pr
  const waiting = (r.waitCount ?? 0) > 0 ? `·wait${r.waitCount}` : ''
  await segment($, `auto·R${r.round}·${r.phase === 'plan' ? 'plan' : `M${done}/${total}`}${pr !== undefined ? `·PR#${pr}` : ''}${waiting}`)
}

// The repository of the session's directory, or of its nearest ancestor that
// still exists. A session that cd'ed into a milestone's worktree keeps it as
// its directory after auto-claude removes that worktree. git cannot even
// start in a missing directory (Bun: "posix_spawn 'git' ENOENT"), and that
// used to read as "Not inside a git repository".
async function sessionRoot($: EngineInterface): Promise<{ root?: string; cwd: string; used: string }> {
  const cwd = await $.session.cwd()
  const dir = await existingDir($, cwd)
  return { root: await repoRoot($, dir), cwd, used: dir }
}

// The session's directory, or the nearest one above it that still exists: a
// session left in a milestone worktree the driver removed after its merge has a
// directory git cannot start in.
async function existingDir($: EngineInterface, cwd: string): Promise<string> {
  let dir = cwd
  while (dir !== '/' && !(await $.fs.exists(dir).catch(() => true))) dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  return dir
}

const notInRepo = (s: { cwd: string; used: string }) =>
  s.used === s.cwd
    ? `Not inside a git repository: ${s.cwd}.`
    : `Not inside a git repository: the session's directory ${s.cwd} no longer exists, and ${s.used} is not in one.`

// A session goal of Claude Code's own (/goal) blocks every stop until it is
// met, and so keeps the loop from judging and starting milestones (measured in
// de-artifact: the run idled until its 24 h cap). A run clears it when it
// starts or resumes; the guard refuses ProposeGoal while it runs. The command
// runs from a timer, since one run from inside a command's hook is refused.
function clearSessionGoal($: EngineInterface): void {
  $.clock.after(50, () => {
    void (async () => {
      const has = (await $.command.list().catch(() => [])).some(c => c.name === 'goal')
      if (has) await $.command.run({ command: 'goal', args: 'clear' }).catch(() => undefined)
    })()
  })
}

// Starts the next milestone when nothing is being built: the loop is called
// directly, so a start the driver wants cannot be refused. A stacked start
// records the commit it builds on, for the rebase once its parent lands.
async function startWanted($: EngineInterface, r: AutoRecord, base: string, stacked: boolean): Promise<void> {
  // Every start the log shows has finished: a goal met during this tick but
  // not read yet must become a ship item before its successor picks a base.
  if (r.started > r.finished) return
  if ((await readLoop($, r.root))?.current !== undefined) return
  const tip = stacked ? (await run($, ['git', '-C', r.root, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`], r.root, 15_000)).stdout.trim() : ''
  if (stacked && tip === '') return
  const current = await startNext($, r.root, base, r.remote, readyOf(r))
  if (current !== undefined && stacked) await writeRecord($, { ...r, onto: { ...r.onto, [current.branch]: tip } })
}

// Another session owns the run. Once its ticks stop, the run is stuck there:
// say so here, once, instead of staying silent.
async function reportOrphan($: EngineInterface, r: AutoRecord): Promise<void> {
  if (!r.on || r.sessionId === undefined || orphanTold === r.sessionId) return
  const quiet = (await $.clock.now()) - (r.beatAt ?? r.startedAt)
  if (quiet < STALE_MS) return
  orphanTold = r.sessionId
  await segment($, 'auto·orphaned')
  await tell($, r, `the session running it went quiet ${Math.round(quiet / 60_000)} min ago, so nothing moves; /${COMMAND} resume in this session takes it over, or /${COMMAND} stop`)
}

async function stopRun($: EngineInterface, r: AutoRecord, why: string, phase: 'stopped' | 'done' = 'stopped'): Promise<AutoRecord> {
  const next: AutoRecord = { ...r, on: false, phase, note: why, pausedPhase: r.phase === 'plan' || r.phase === 'standby' ? r.phase : 'run' }
  await stopLoop($, r.root)
  await writeRecord($, next)
  await tell($, next, `${phase === 'done' ? 'finished' : 'stopped'}: ${why}. ${summary(next.merges, next.held, next.ships)}`)
  return next
}

// The milestone's worktree, made again from its branch when it was removed.
// A missing directory as a process's cwd fails as "posix_spawn 'git' ENOENT"
// (measured in Bun), which once looked like a missing git for a whole 24 h run.
async function worktreeOf($: EngineInterface, r: AutoRecord, item: ShipItem): Promise<{ wt: string } | { gone: string }> {
  const wt = item.worktree ?? r.root
  if ((await run($, ['test', '-d', wt], r.root, 15_000)).exitCode === 0) return { wt }
  if ((await run($, ['git', '-C', r.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${item.branch}`], r.root, 15_000)).exitCode !== 0) {
    return { gone: `its worktree ${wt} and branch ${item.branch} are gone` }
  }
  await run($, ['git', '-C', r.root, 'worktree', 'prune'], r.root, 15_000)
  const made = await run($, ['git', '-C', r.root, 'worktree', 'add', wt, item.branch], r.root, 60_000)
  return made.exitCode === 0 ? { wt } : { gone: `its worktree ${wt} could not be made again: ${out(made)}` }
}

// The milestone's check, run once more in a fresh detached checkout of `ref`
// right before it lands: never the builder's worktree, where untracked or
// ignored files and local state can make a check pass that main would fail.
async function verifyFresh($: EngineInterface, r: AutoRecord, item: ShipItem, ref: string): Promise<string | undefined> {
  if (item.check === undefined) return undefined
  const dir = `${r.root}/worktrees/auto-verify`
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  const made = await run($, ['git', '-C', r.root, 'worktree', 'add', '--detach', dir, ref], r.root, 60_000)
  if (made.exitCode !== 0) return `could not make a fresh checkout of ${ref}: ${out(made)}`
  const checked = await run($, ['bash', '-lc', item.check], dir, 600_000)
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)

  return checked.exitCode === 0 ? undefined : `check failed in a fresh checkout of ${ref} (it passed in the builder's worktree): ${out(checked)}`
}

// A milestone given up on: held, told, and counted for the circuit breaker
// (two in a row for one cause stop the run, in tick).
async function hold($: EngineInterface, r: AutoRecord, item: ShipItem, note: string): Promise<{ r: AutoRecord; item: ShipItem }> {
  const cause = causeOf(note)
  const streak = r.holdCause === cause ? (r.holdStreak ?? 0) + 1 : 1
  await tell($, r, `held: ${item.goal.slice(0, 60)}${item.pr !== undefined ? ` (PR #${item.pr})` : ''}: ${note.slice(0, 160)}; going on with the next milestone`)
  const ids = lineIssues(item.goal)
  if (r.linear !== undefined && ids.length > 0) r = { ...r, linear: await onHeld($, r.linear, ids, `${item.pr !== undefined ? `PR #${item.pr}: ` : ''}${note}`) }
  // A held repair frees the stacked milestones; their deploys count toward the stop.
  return { r: { ...r, held: r.held + 1, holdCause: cause, holdStreak: streak, ...(item.repair === true ? { repair: undefined } : {}) }, item: { ...item, state: 'held', note } }
}

// GitHub's runs of a PR's branch, cancelled and run again once when its CI
// does not finish (a run queued for a runner that never came).
async function rerunCi($: EngineInterface, wt: string, repo: string[], headRef: string): Promise<void> {
  const listed = await run($, ['gh', 'run', 'list', ...repo, '--branch', headRef, '--json', 'databaseId,status', '--limit', '20'], wt)
  let runs: Array<{ databaseId?: number; status?: string }> = []
  try {
    runs = JSON.parse(listed.stdout) as typeof runs
  } catch {
    runs = []
  }
  const flags = repo.map(a => `'${a.replace(/'/g, '')}'`).join(' ')
  for (const ci of Array.isArray(runs) ? runs : []) {
    if (typeof ci.databaseId !== 'number' || ci.status === 'completed') continue
    // gh refuses to re-run a run that is still cancelling: wait (up to 60 s) for it to complete.
    const id = String(ci.databaseId)
    await run($, ['bash', '-lc', `gh run cancel ${id} ${flags}; for i in $(seq 30); do [ "$(gh run view ${id} ${flags} --json status -q .status)" = completed ] && break; sleep 2; done; gh run rerun ${id} ${flags}`], wt, 90_000)
  }
}

async function allQueued($: EngineInterface, wt: string, repo: string[], headRef: string): Promise<boolean> {
  const listed = await run($, ['gh', 'run', 'list', ...repo, '--branch', headRef, '--json', 'status', '--limit', '20'], wt)
  try {
    const runs = JSON.parse(listed.stdout) as Array<{ status?: string }>
    return Array.isArray(runs) && runs.length > 0 && runs.every(x => x.status === 'queued' || x.status === 'waiting' || x.status === 'pending')
  } catch {
    return false
  }
}

// One step of a milestone through push, CI and merge.
async function advance($: EngineInterface, r: AutoRecord, item: ShipItem): Promise<{ r: AutoRecord; item: ShipItem }> {
  const update = (patch: Partial<ShipItem>) => ({ ...item, ...patch })
  if (item.state !== 'push' && item.state !== 'ci') return { r, item }
  const where = await worktreeOf($, r, item)
  if ('gone' in where) return hold($, r, item, where.gone)
  const wt = where.wt
  // gh is told which repository the branch was pushed to (see repoSlug).
  const slug = r.remote === LOCAL ? undefined : repoSlug((await run($, ['git', '-C', wt, 'remote', 'get-url', r.remote], wt, 15_000)).stdout)
  const repo = slug === undefined ? [] : ['--repo', slug]
  const now = await $.clock.now()

  if (item.state === 'push') {
    if (r.ciMode === 'local') return { r, item: update({ state: 'ci' }) }
    // An SSH remote that refused (no key in an unattended shell) is pushed over https instead.
    const target = (item.tried ?? []).includes('https-push') && slug !== undefined ? httpsOf(slug) : r.remote
    const pushed = await run($, ['git', '-C', wt, 'push', '-u', target, `${item.branch}:${item.headRef}`, ...(item.branch !== item.headRef || item.rebased === true ? ['--force-with-lease'] : [])], wt)
    if (pushed.exitCode !== 0) return { r, item: update({ note: `push failed: ${out(pushed)}` }) }
    if (item.pr !== undefined) return { r, item: update({ state: 'ci', since: now, note: undefined, rerunAt: undefined }) }
    const made = await run($, ['gh', 'pr', 'create', ...repo, '--head', item.headRef, '--base', r.defaultBranch, '--title', item.goal.slice(0, 120), '--body', `Milestone of an auto-claude run.\n\nCheck: \`${item.check ?? '-'}\`\n\nPlan: .claude/auto-plan.md (local to the run).`], wt)
    const pr = prNumber(made.stdout + made.stderr)
    if (pr === undefined) return { r, item: update({ note: `gh pr create failed: ${out(made)}` }) }
    await tell($, r, `opened PR #${pr}: ${item.goal.slice(0, 80)}`)
    return { r, item: update({ state: 'ci', pr, since: now, note: undefined, rerunAt: undefined }) }
  }

  let failure: string | undefined
  if (r.ciMode === 'local') {
    await fetchRemote($, r, wt)
    const rebased = await run($, ['git', '-C', wt, 'rebase', refOf(r)], wt)
    if (rebased.exitCode !== 0) {
      await run($, ['git', '-C', wt, 'rebase', '--abort'], wt)
      failure = `does not rebase onto ${r.defaultBranch}: ${out(rebased)}`
    } else {
      // The rebased commit is what lands, so that is what the check judges.
      const head = (await run($, ['git', '-C', wt, 'rev-parse', 'HEAD'], wt)).stdout.trim()
      failure = await verifyFresh($, r, item, head === '' ? item.branch : head)
      if (failure === undefined) {
        const pushed = await run($, ['git', '-C', wt, 'push', r.remote, `HEAD:${r.defaultBranch}`], wt)
        if (pushed.exitCode !== 0) failure = `push to ${r.defaultBranch} failed: ${out(pushed)}`
      }
    }
  } else {
    // A CI that does not finish (no runner takes it) is re-run once, then held.
    const queued = now - (item.rerunAt ?? item.since) >= 30 * 60_000 ? await allQueued($, wt, repo, item.headRef) : false
    const action = ciAction(item, now, queued)
    if (action === 'rerun') {
      await rerunCi($, wt, repo, item.headRef)
      await tell($, r, `PR #${item.pr ?? '?'}: CI did not finish in ${Math.round((now - item.since) / 60_000)} min; cancelled and re-ran its runs`)
      return { r, item: update({ rerunAt: now }) }
    }
    if (action === 'hold') return hold($, r, item, `CI did not finish: waited ${Math.round((now - item.since) / 60_000)} min, re-run once`)
    // Only required checks decide; with none required, every check does.
    let asked = await run($, ['gh', 'pr', 'checks', String(item.pr), ...repo, '--required', '--json', 'bucket'], wt)
    if (noRequired(asked)) asked = await run($, ['gh', 'pr', 'checks', String(item.pr), ...repo, '--json', 'bucket'], wt)
    const checks = parseChecks(asked.stdout)
    if (checks === 'pending') return { r, item }
    // The runs the driver cancelled to re-run them read as cancelled for a while.
    if (checks === 'red' && item.rerunAt !== undefined && onlyCancelled(asked.stdout)) return { r, item }
    // Asked right after the PR was opened, GitHub has usually not registered
    // its checks yet: that is pending too, until the grace runs out.
    if (checks === 'none' && now - item.since < NO_CI_GRACE_MS) return { r, item }
    if (checks === 'red') failure = 'CI failed (gh pr checks --required)'
    if (failure === undefined) {
      // Looked at again right before merging.
      const state = mergeable((await run($, ['gh', 'pr', 'view', String(item.pr), ...repo, '--json', 'state,mergeable'], wt)).stdout)
      if (state.unknown) return { r, item }
      // A merge whose reply was lost (a 502 after GitHub merged it) has landed.
      if (state.merged) {
        // Fall through to the merged bookkeeping below.
      } else if (!state.open) {
        // Closed by someone or something: opened again once, then held.
        if ((item.tried ?? []).includes('reopen')) return hold($, r, item, 'the PR is no longer open')
        await run($, ['gh', 'pr', 'reopen', String(item.pr), ...repo], wt)
        return { r, item: update({ tried: [...(item.tried ?? []), 'reopen'], since: now }) }
      } else if (state.conflict) failure = `conflicts with ${r.defaultBranch}`
      else {
        // CI judged the PR; the milestone's own check is judged on the pushed head too.
        await run($, ['git', '-C', r.root, 'fetch', '-q', r.remote, item.headRef], r.root)
        failure = await verifyFresh($, r, item, `${r.remote}/${item.headRef}`)
      }
      if (failure === undefined && !state.merged) {
        const merged = await run($, ['gh', 'pr', 'merge', String(item.pr), ...repo, '--squash', '--delete-branch'], wt)
        if (merged.exitCode !== 0) {
          // The reply may be lost after GitHub merged it (measured: a 502): asked again before it counts as a failure.
          const again = mergeable((await run($, ['gh', 'pr', 'view', String(item.pr), ...repo, '--json', 'state,mergeable'], wt)).stdout)
          if (!again.merged) return { r, item: update({ note: `merge failed: ${out(merged)}` }) }
        }
      }
    }
  }

  if (failure === undefined) {
    // The milestone's worktrees go; a dirty one stays for a look.
    for (const path of new Set([item.worktree, r.worktrees[item.headRef]].filter((p): p is string => p !== undefined))) {
      await run($, ['git', '-C', r.root, 'worktree', 'remove', path], r.root)
    }
    const landed = item.pr !== undefined ? `PR #${item.pr}` : `into ${r.defaultBranch}`
    const mergedAt = await $.clock.now()
    let next: AutoRecord = {
      ...r,
      merges: r.merges + 1,
      holdStreak: 0,
      holdCause: undefined,
      ...(item.repair === true ? { repair: undefined } : {}),
      ...(r.alwaysOn === true ? { mergeTimes: [...recentMerges(r.mergeTimes, mergedAt), mergedAt] } : {}),
    }
    await tell($, next, `merged ${landed}: ${item.goal.slice(0, 80)}`)
    // A labelled GitHub issue the milestone resolved is closed with the evidence.
    for (const n of lineGhIssues(item.goal)) {
      await run($, ['gh', 'issue', 'close', String(n), ...repo, '--comment', `[auto-claude] Resolved by ${landed}: ${item.goal.slice(0, 160)}`], r.root, 30_000)
    }
    const ids = lineIssues(item.goal)
    if (next.linear !== undefined && ids.length > 0) {
      // The merged tip, fetched first: the local ref still points before the merge.
      await fetchRemote($, r, r.root)
      const sha = (await run($, ['git', '-C', r.root, 'rev-parse', '--short', refOf(r)], r.root, 15_000)).stdout.trim()
      const done = await onMerged($, next.linear, ids, `Merged ${landed}${sha !== '' ? ` (${r.defaultBranch} at ${sha})` : ''}: ${item.goal.slice(0, 160)}`)
      for (const line of done.lines) await appendQueue($, r.root, line)
      next = { ...next, linear: done.sync }
    }
    const merged = update({ state: 'merged', note: undefined })
    if (r.deploy !== undefined) next = await deployAfter($, next, r.deploy, landed)
    return { r: next, item: merged }
  }

  const red = item.red + 1
  if (red >= MAX_RED) return hold($, r, { ...item, red }, `after ${red} failures: ${failure.slice(0, 160)}`)
  // A fix goal on top of the milestone's branch; the loop picks it up next.
  const line = fixLine(item.goal, item.pr, failure, item.check, item.branch)
  const condition = parseQueue(line)[0]!.condition
  await appendQueue($, r.root, line)
  return { r: { ...r, fixes: { ...r.fixes, [condition]: item.headRef } }, item: update({ state: 'fixing', red, note: failure }) }
}

async function appendQueue($: EngineInterface, root: string, line: string): Promise<void> {
  const queue = (await readText($, FILES(root).queue)) ?? ''
  await $.fs.write(FILES(root).queue, `${queue}${queue === '' || queue.endsWith('\n') ? '' : '\n'}${line}\n`)
}

async function deployAfter($: EngineInterface, r: AutoRecord, spec: DeploySpec, landed: string): Promise<AutoRecord> {
  const result = await deployMerged($, r, spec)
  if (result.kind === 'ok') {
    await tell($, r, `deployed after ${landed}${spec.smoke !== undefined ? '; smoke check passed' : ''}`)
    return { ...r, deploys: (r.deploys ?? 0) + 1, deployFails: 0, deployDue: false }
  }
  if (result.kind === 'skipped') {
    $.ui.toast(`auto-claude: deploy waits: ${result.why}`)
    return { ...r, deployDue: true }
  }
  return deployFailed($, r, spec, `the deploy after ${landed} failed: ${result.why}`)
}

async function deployFailed($: EngineInterface, r: AutoRecord, spec: DeploySpec, why: string): Promise<AutoRecord> {
  const fails = (r.deployFails ?? 0) + 1
  const next: AutoRecord = { ...r, deployFails: fails, deployDue: true }
  if (fails >= MAX_DEPLOY_FAILS) return stopRun($, next, `${why}; ${fails} deploys failed in a row, so nothing more is merged on top of what is live`)
  const line = deployFixLine(spec.command, spec.smoke, why, refOf(r))
  await appendQueue($, r.root, line)
  await tell($, next, `${why}; a milestone that repairs the deploy goes first (deploy failure ${fails}/${MAX_DEPLOY_FAILS})`)
  return { ...next, repair: parseQueue(line)[0]!.condition }
}

async function finalCheck($: EngineInterface, r: AutoRecord, caps: Caps): Promise<AutoRecord> {
  if (r.buildOnly === true) return stopRun($, r, `the queue is built (${r.finished} goal(s)); branches are left for review`, 'done')
  const plan = await readText($, FILES(r.root).plan)
  const check = plan === undefined ? undefined : finalCheckOf(plan)
  if (check === undefined) return stopRun($, r, 'auto-plan.md lost its final check')
  // Judged on what was merged: a fresh detached checkout of the default branch.
  const dir = `${r.root}/worktrees/auto-final`
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  await fetchRemote($, r, r.root)
  const made = await run($, ['git', '-C', r.root, 'worktree', 'add', '--detach', dir, refOf(r)], r.root)
  const ran = made.exitCode === 0 ? await run($, ['bash', '-lc', check], dir, 600_000) : made
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  if (ran.exitCode === 0) {
    // Done means live: a merge whose deploy was skipped or failed deploys now.
    const spec = r.deploy
    if (spec !== undefined && r.deployDue === true) {
      const result = await deployMerged($, r, spec)
      if (result.kind === 'skipped') return stopRun($, r, `the final check passed, but the deploy never became runnable: ${result.why}`)
      if (result.kind === 'failed') {
        const next = await deployFailed($, { ...r, phase: 'run' }, spec, `the final deploy failed: ${result.why}`)
        if (next.on) await writeRecord($, next)
        return next
      }
      r = { ...r, deploys: (r.deploys ?? 0) + 1, deployFails: 0, deployDue: false }
      await tell($, r, `deployed what was merged${spec.smoke !== undefined ? '; smoke check passed' : ''}`)
    }
    const plan2 = (await readText($, FILES(r.root).plan)) ?? ''
    const live = r.deploy !== undefined ? ` Deployed ${r.deploys ?? 0} time(s) with \`${r.deploy.command}\`.` : r.deployNone !== undefined ? ` Nothing deployed: ${r.deployNone}.` : ''
    // A cycle an always-on run woke for logs one line under ## Cycles; the planned run its Result.
    if ((r.cycle ?? 0) === 0) await $.fs.write(FILES(r.root).plan, `${plan2.trimEnd()}\n\n## Result\n\nFinished ${new Date().toISOString()}: round ${r.round}, ${summary(r.merges, r.held, r.ships)}. Final check passed: \`${check}\`.${live}\n`)
    if (r.alwaysOn === true && (r.cycle ?? 0) > 0) await $.fs.write(FILES(r.root).plan, withCycle(plan2, cycleLine(r, new Date().toISOString())))
    if (r.alwaysOn === true) return enterStandby($, r, `the final check passed${(r.cycle ?? 0) > 0 ? ` (cycle ${r.cycle})` : ` after ${r.round} round(s)`}`)
    return stopRun($, r, `the final check passed after ${r.round} round(s)${r.deploy !== undefined ? ' and what was merged is deployed' : ''}`, 'done')
  }
  if (r.round >= caps.maxRounds) return stopRun($, r, `the final check still fails after ${r.round} round(s)`)
  let next: AutoRecord = { ...r, phase: 'plan', round: r.round + 1, queueEmpty: false, phaseAt: await $.clock.now(), nudges: 0 }
  const kick = r.linear === undefined ? {} : await linearKickoff($, r.root)
  // Changes a replan sees in the brief are covered by the lines it writes.
  if (kick.linear !== undefined && r.linear !== undefined) next = { ...next, linear: { ...kick.linear, followUps: r.linear.followUps } }
  await writeRecord($, next)
  const text = replanText(next.round, check, `${ran.stdout}\n${ran.stderr}`, kick.brief)
  $.clock.after(100, () => {
    $.prompt.submit({ text }).catch(() => {})
  })
  return next
}

// How long the session has had no turn, while nothing else (a judge, an armed
// retry) holds it; undefined while it is busy.
function quietFor(now: number, since: number): number | undefined {
  if (watch.turnActive || watch.judging || now < watch.retryUntil) return undefined
  return now - Math.max(watch.lastTurnEndAt ?? watch.loadedAt, since)
}

// Planning is a model turn that may end without auto_plan_ready (a question
// nobody answers, a turn that ended to "wait", a dropped prompt): remind it
// soon after its turn ends, else every PLAN_NUDGE_MS; then give up.
function planNudgeDue(r: AutoRecord, now: number): boolean {
  if (r.phaseAt === undefined) return true
  if (now - r.phaseAt >= PLAN_NUDGE_MS) return true
  const ended = watch.lastTurnEndAt
  return !watch.turnActive && ended !== undefined && ended > r.phaseAt && now - ended >= PLAN_QUIET_MS
}

// Planning: remind a model that has not accepted a plan, then give up.
async function planTick($: EngineInterface, r: AutoRecord): Promise<void> {
  const now = await $.clock.now()
  if (planNudgeDue(r, now)) {
    const nudges = r.phaseAt === undefined ? 0 : (r.nudges ?? 0) + 1
    if (nudges > MAX_NUDGES) {
      await stopRun($, r, `no plan was accepted after ${MAX_NUDGES} reminders`)
      return
    }
    r = { ...r, phaseAt: now, nudges }
    if (nudges > 0) {
      const f = FILES(r.root)
      const verdict = validatePlan(await readText($, f.plan), await readText($, f.queue), r.round === 1, r.deploy?.source === 'file')
      $.prompt.submit({ text: planNudgeText(nudges, MAX_NUDGES, verdict.ok ? [] : verdict.errors) }).catch(() => {})
    }
  }
  await writeRecord($, r)
}

// Every step that is ready runs now, not one per tick: a milestone met with
// its CI already green is pushed, opened, landed and followed by the next
// start in this one tick.
async function shipSteps($: EngineInterface, r: AutoRecord): Promise<AutoRecord> {
  for (let steps = 0; steps < MAX_STEPS && r.on; steps++) {
    let item = inFlight(r.ships)
    if (item === undefined) {
      // The milestone ahead landed or was held: the first stacked one goes next,
      // unless the deploy is being repaired (nothing merges on top of it).
      const waiting = r.repair === undefined ? r.ships.find(s => s.state === 'stacked') : undefined
      if (waiting === undefined) break
      const moved = await unstack($, r, waiting)
      r = { ...moved.r, ships: moved.r.ships.map(s => (s.headRef === waiting.headRef ? moved.item : s)) }
      if (moved.item.state !== 'push') break
      item = moved.item
    }
    if (item.state === 'fixing') break
    const step = await advance($, r, item)
    if (!step.r.on) return step.r
    const same = step.item.note !== undefined && step.item.note === item.note && step.item.state === item.state
    const now = await $.clock.now()
    const noteSince = step.item.note === undefined ? undefined : same ? (item.noteSince ?? now) : now
    const treated = await treat($, step.r, { ...step.item, repeats: same ? (item.repeats ?? 0) + 1 : 0, noteSince }, now)
    r = { ...treated.r, ships: treated.r.ships.map(s => (s.headRef === item.headRef ? treated.item : s)) }
    // Waiting (CI pending, an error to retry): the next tick looks again.
    if (treated.item.state === item.state) break
  }
  return r
}

// A stacked milestone whose turn has come: its branch is rebased onto the
// default branch, dropping the commits of the milestone it was built on
// (landed as one squashed commit, or held and never landed). One that does
// not rebase gets a fix goal that does it by hand.
async function unstack($: EngineInterface, r: AutoRecord, item: ShipItem): Promise<{ r: AutoRecord; item: ShipItem }> {
  const where = await worktreeOf($, r, item)
  if ('gone' in where) return hold($, r, item, where.gone)
  const wt = where.wt
  await fetchRemote($, r, wt)
  const onto = item.onto
  const args = onto !== undefined ? ['rebase', '--onto', refOf(r), onto] : ['rebase', refOf(r)]
  const rebased = await run($, ['git', '-C', wt, ...args], wt)
  const now = await $.clock.now()
  const { onto: _done, ...rest } = item
  if (rebased.exitCode === 0) return { r, item: { ...rest, state: 'push', since: now, rebased: true } }
  await run($, ['git', '-C', wt, 'rebase', '--abort'], wt)
  const how = onto !== undefined ? `git rebase --onto ${refOf(r)} ${onto}` : `git rebase ${refOf(r)}`
  const failure = `it was built on a milestone that has since landed or been held, and does not rebase onto ${r.defaultBranch}; run ${how} and resolve the conflicts: ${out(rebased).slice(0, 120)}`
  const line = fixLine(item.goal, undefined, failure, item.check, item.branch)
  await appendQueue($, r.root, line)
  return { r: { ...r, fixes: { ...r.fixes, [parseQueue(line)[0]!.condition]: item.headRef } }, item: { ...rest, state: 'fixing', red: item.red + 1, note: failure, since: now } }
}

// An error that keeps coming back is treated, not just retried.
async function treat($: EngineInterface, r: AutoRecord, item: ShipItem, now: number): Promise<{ r: AutoRecord; item: ShipItem }> {
  const remedy = shipRemedy(item, now)
  if (remedy === 'https-push') {
    $.ui.toast('auto-claude: the SSH remote refused the push; pushing over https instead')
    return { r, item: { ...item, tried: [...(item.tried ?? []), 'https-push'] } }
  }
  if (remedy === 'diagnose') {
    const asked = { ...item, tried: [...(item.tried ?? []), 'diagnose'], askedAt: now }
    return { r, item: (await askModel($, r, asked)) ? asked : item }
  }
  if (remedy === 'hold') return hold($, r, item, `stuck at ${item.state} for ${item.repeats} checks: ${item.note ?? ''}`)
  return { r, item }
}

// The next milestone (a fix goal included), or the end. A milestone is
// started even while another ships: stacked on its branch, so the session
// keeps building through the CI (ship.ts startBase).
async function nextOrFinish($: EngineInterface, r: AutoRecord, caps: Caps): Promise<void> {
  if (r.phase !== 'run') return
  const items = parseQueue((await readText($, FILES(r.root).queue)) ?? '')
  const next = nextPending(items, readyOf(r))
  if (next !== undefined) {
    const at = startBase(r, next, refOf(r))
    if (at !== undefined) await startWanted($, r, at.base, at.stacked)
    return
  }
  // Lines still waiting on their `:: after:`: the run is not done, and no
  // round is spent on a final check that cannot pass yet. pollWaits starts
  // them when what they wait for is done.
  if (waitingItems(items, readyOf(r)).length > 0) return
  const building = (await readLoop($, r.root))?.current !== undefined
  if (unfinished(r.ships).length === 0 && !building && r.started <= r.finished) {
    // The run is not done while Linear has changes it has not queued.
    const synced = await linearSync($, r, true)
    if (synced.r.linear !== r.linear) await writeRecord($, synced.r)
    if (synced.added > 0) return
    await finalCheck($, { ...synced.r, phase: 'final' }, caps)
  }
}

// A pending line may start: it waits on nothing, or its `:: after:` passed.
function readyOf(r: Pick<AutoRecord, 'waits'>): (item: QueueItem) => boolean {
  return item => item.after === undefined || r.waits?.[item.condition]?.ok === true
}

// Polls the `:: after:` of each waiting line (every WAIT_POLL_MS), and its
// `:: alive:`: the driver, not the model, watches a training run or a cache
// build, so a run never ends, or sits stopped, while compute it waits for is
// still running. A wait that looks dead (alive failing) or late (past its
// `within`) goes to the model once; past twice its `within` it is held.
async function pollWaits($: EngineInterface, r: AutoRecord): Promise<AutoRecord> {
  if (r.phase !== 'run') return r
  const now = await $.clock.now()
  const building = (await readLoop($, r.root))?.current?.condition
  const items = parseQueue((await readText($, FILES(r.root).queue)) ?? '').filter(i => i.mark === ' ' && i.after !== undefined && i.condition !== building)
  const old = r.waits ?? {}
  const waits: Record<string, WaitState> = {}
  let held = 0
  let fetched = false
  for (const item of items) {
    const after = item.after!
    let w: WaitState = old[item.condition] ?? { since: now }
    if (w.ok !== true && now - (w.checkedAt ?? 0) >= WAIT_POLL_MS) {
      // A wait on what reached the remote (`git cat-file -e origin/main:x`) sees it fetched.
      if (!fetched && r.remote !== LOCAL && after.includes(`${r.remote}/`)) {
        await fetchRemote($, r, r.root)
        fetched = true
      }
      const ran = await run($, ['bash', '-lc', after], r.root, WAIT_PROBE_MS).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
      w = { ...w, checkedAt: now }
      if (ran.exitCode === 0) {
        w = { ...w, ok: true, out: undefined }
        await tell($, r, `wait over after ${hours(now - w.since)}: ${item.condition.slice(0, 80)}; it starts next`)
      } else {
        w = { ...w, out: `\`${after.slice(0, 120)}\` exited ${ran.exitCode}${out(ran) !== '' ? `: ${out(ran).slice(0, 300)}` : ''}` }
        if (item.alive !== undefined) {
          const alive = await run($, ['bash', '-lc', item.alive], r.root, WAIT_PROBE_MS).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
          w = alive.exitCode === 0
            ? { ...w, aliveFails: 0, askedDead: false }
            : { ...w, aliveFails: (w.aliveFails ?? 0) + 1, out: `alive \`${item.alive.slice(0, 120)}\` exited ${alive.exitCode}${out(alive) !== '' ? `: ${out(alive).slice(0, 200)}` : ''}; ${w.out}` }
        }
        const waited = now - w.since
        if (item.withinMs !== undefined && waited > 2 * item.withinMs) {
          const text = (await readText($, FILES(r.root).queue)) ?? ''
          await $.fs.write(FILES(r.root).queue, markItem(text, item.condition, '!', `held ${new Date(now).toISOString()}: waited ${hours(waited)}, twice its within; ${w.out ?? ''}`))
          await tell($, r, `held: ${item.condition.slice(0, 80)} waited ${hours(waited)}, twice its within; ${(w.out ?? '').slice(0, 150)}; going on`)
          held++
          continue
        }
        const dead = (w.aliveFails ?? 0) >= ALIVE_FAILS
        const late = waited > (item.withinMs ?? WAIT_ASK_MS)
        if (dead && w.askedDead !== true) {
          if (await askWait($, r, item, w, 'dead')) w = { ...w, askedDead: true }
        } else if (late && w.askedLate !== true) {
          if (await askWait($, r, item, w, 'late')) w = { ...w, askedLate: true }
        }
      }
    }
    waits[item.condition] = w
  }
  const waitCount = Object.values(waits).filter(w => w.ok !== true).length
  let next: AutoRecord = { ...r, waits, waitCount, held: r.held + held }
  // Time with nothing to do but wait is left out of the time cap.
  if (onlyWaiting(next)) next = { ...next, waitedMs: (r.waitedMs ?? 0) + (r.waitTickAt !== undefined ? now - r.waitTickAt : 0), waitTickAt: now }
  else next = { ...next, waitTickAt: undefined }
  return next
}

const hours = (ms: number) => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`)

// A wait that looks dead or late goes to the model, which can look at the job
// (logs, tmux, the GPU) and relaunch it or fix the line. Not while it builds a
// milestone: asked at a later poll instead.
async function askWait($: EngineInterface, r: AutoRecord, item: QueueItem, w: WaitState, why: 'dead' | 'late'): Promise<boolean> {
  if ((await readLoop($, r.root))?.current !== undefined) return false
  const since = hours((await $.clock.now()) - w.since)
  const text = [
    `[auto-claude] A wait looks ${why === 'dead' ? 'dead' : 'late'}: "${item.condition.slice(0, 160)}" has waited ${since} on \`${item.after ?? ''}\`.`,
    why === 'dead'
      ? `Its alive check \`${item.alive ?? ''}\` failed ${w.aliveFails ?? 0} polls in a row: the job it waits for may have died (a crash, a reboot).`
      : item.withinMs !== undefined
        ? `That is longer than its within (${hours(item.withinMs)}).`
        : `No line waits this long unasked (${hours(WAIT_ASK_MS)}); it has no within of its own.`,
    `Last poll: ${(w.out ?? '').slice(0, 600)}`,
    'Find out from here whether the job is still running (its log, tmux, the GPU). Relaunch it if it died, or fix the line\'s `:: after:` / `:: alive:` in .claude/goals.md if they test the wrong thing. Do not wait for it and do not defer it: end the turn, and auto-claude keeps polling. Note what you found under ## Decisions in .claude/auto-plan.md.',
  ].join('\n')
  await tell($, r, `${why === 'dead' ? 'a waited-on job looks dead' : 'a wait is late'} (${since}): ${item.condition.slice(0, 80)}; the model was asked to look`)
  $.prompt.submit({ text }).catch(() => {})
  return true
}

// The sources a run standing by polls, for its notices and status.
function sourceNames(r: AutoRecord): string {
  const names = [...(r.linear !== undefined ? ['Linear'] : []), ...sourcesOf(r).map(s => (s === 'health' ? `the smoke check every ${standbyCfg.healthMs / 60_000} min` : `${r.defaultBranch}'s CI${standbyCfg.issueLabel !== '' ? ` and issues labelled "${standbyCfg.issueLabel}"` : ''} every ${standbyCfg.githubMs / 60_000} min`))]
  return names.length > 0 ? names.join(', ') : 'nothing (no Linear project, no smoke check, no GitHub CI): only /auto-claude resume wakes it'
}

// An always-on run whose final check passed: it stays on and stands by. A
// cycle it woke for logs its line under ## Cycles in auto-plan.md, which is
// what the run remembers of it (and what it told the person).
async function enterStandby($: EngineInterface, r: AutoRecord, why: string): Promise<AutoRecord> {
  const now = await $.clock.now()
  const next: AutoRecord = {
    ...r,
    on: true,
    phase: 'standby',
    standbyAt: now,
    note: why,
    healthFails: 0,
    dayCapTold: false,
    // GitHub is looked at once at once (a red default branch is work now);
    // the service was just smoke-checked by its deploy.
    timers: { health: now + standbyCfg.healthMs, github: now },
  }
  await writeRecord($, next)
  await tell($, next, `${why}; standing by (${summary(next.merges, next.held, next.ships)}). Wakes on ${sourceNames(next)}`)
  return next
}

// The session is free for a wake: no turn now, and none for WAKE_QUIET_MS.
function sessionQuiet(now: number): boolean {
  return !watch.turnActive && !watch.judging && now - (watch.lastTurnEndAt ?? watch.loadedAt) >= WAKE_QUIET_MS
}

// Standby: no model turn. Polls what is due, queues what changed, compacts
// the session once, and wakes the run when the queue has work and the
// session is free. A poll that finds nothing tells nothing.
async function standbyTick($: EngineInterface, r: AutoRecord): Promise<void> {
  const now = await $.clock.now()
  r = (await linearSync($, r)).r
  const due = dueSources(r, now)
  if (due.includes('health') && r.repair === undefined && r.deploy !== undefined) {
    const h = await pollHealth($, r)
    const fails = h.ok ? 0 : (r.healthFails ?? 0) + 1
    // Only what found something is logged: a quiet poll every few minutes would fill the log's 2000 lines.
    if (!h.ok) await appendLog($, r.root, { event: 'poll', source: 'health', ok: false, out: h.out })
    if (fails >= HEALTH_FAILS) {
      r = await deployFailed($, { ...r, healthFails: 0 }, r.deploy, `the smoke check \`${r.deploy.smoke ?? ''}\` failed ${fails} times in a row while standing by (${h.out})`)
      if (!r.on) return
    } else {
      r = { ...r, healthFails: fails }
    }
  }
  if (due.includes('github')) {
    const g = await pollGithub($, r, standbyCfg.issueLabel)
    const got = eventLines(g.events, r.seen ?? {}, r.followUps ?? {})
    for (const line of got.lines) await appendQueue($, r.root, line)
    if (got.lines.length > 0 || g.error !== undefined) await appendLog($, r.root, { event: 'poll', source: 'github', queued: got.lines.length, ...(g.error !== undefined ? { error: g.error } : {}) })
    // A failing poll is told once, when it starts failing.
    if (g.error !== undefined && r.githubError === undefined) await tell($, r, `GitHub poll failed: ${g.error}; retried every ${standbyCfg.githubMs / 60_000} min`)
    r = { ...r, seen: got.seen, followUps: got.followUps, githubError: g.error }
  }
  r = { ...r, timers: nextTimers(r, due, standbyCfg, now) }

  // A lean session for the next cycle: compacted once per standby, between turns.
  const quiet = sessionQuiet(now)
  if (quiet && r.compactedFor !== r.standbyAt) {
    try {
      const percent = (await $.session.usage()).context.percent ?? 0
      if (percent >= COMPACT_PERCENT) await $.session.compact({ instructions: 'An auto-claude run stands by between cycles. Keep its goal, its decisions and what each cycle did (.claude/auto-plan.md holds them); drop the milestones\' working detail.' })
    } catch {
      // A turn started meanwhile, or the engine refused: the next standby tries again.
    }
    r = { ...r, compactedFor: r.standbyAt }
  }

  const ready = parseQueue((await readText($, FILES(r.root).queue)) ?? '').filter(i => i.mark === ' ' && readyOf(r)(i))
  let woke = false
  if (ready.length > 0) {
    if (dayCapHit(r.mergeTimes, now, standbyCfg.maxMergesPerDay)) {
      if (r.dayCapTold !== true) {
        await tell($, r, `${ready.length} queued line(s) wait: ${standbyCfg.maxMergesPerDay} merges in the last 24 h is the daily cap; the run wakes as older merges age out`)
        r = { ...r, dayCapTold: true }
      }
    } else if (quiet) {
      const ids = ready.map(i => i.condition.match(/^\[([^\]]+)\]/)?.[1] ?? i.condition.slice(0, 40))
      r = {
        ...r,
        phase: 'run',
        cycle: (r.cycle ?? 0) + 1,
        cycleBase: { merges: r.merges, held: r.held, deploys: r.deploys ?? 0 },
        wokeFor: ids.slice(0, 10),
        round: 1,
        startedAt: now,
        waitedMs: 0,
        queueEmpty: false,
        movedAt: undefined,
        idleNudges: 0,
        holdStreak: 0,
        note: undefined,
      }
      woke = true
      // A /goal set while it stood by would block the cycle's stops (see clearSessionGoal).
      clearSessionGoal($)
      await tell($, r, `woke for ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` and ${ids.length - 5} more` : ''}: cycle ${r.cycle} starts`)
    }
  }
  await writeRecord($, r)
  if (woke) $.clock.after(100, () => void tickNow?.())
}

async function tick($: EngineInterface, caps: Caps, pollMs: number): Promise<void> {
  if (ticking || activeRoot === undefined) return
  ticking = true
  let failed = false
  try {
    const got = await readRecord($, activeRoot)
    if (got === undefined) return
    if (got.sessionId !== (await $.session.id())) {
      await reportOrphan($, got)
      return
    }
    if (!got.on) return
    let r: AutoRecord = { ...got, beatAt: await $.clock.now() }
    if ((await readText($, FILES(r.root).stop)) !== undefined) {
      await stopRun($, r, '.claude/auto-claude.stop appeared')
      return
    }
    if (r.phase === 'standby') {
      await standbyTick($, r)
      return
    }
    // The engine's clock, like every other time the run keeps (beatAt, phaseAt, movedAt).
    const cap = capReached(r, caps, await $.clock.now())
    if (cap !== undefined) {
      await stopRun($, r, cap)
      return
    }

    if (r.phase === 'plan') {
      await planTick($, r)
      return
    }

    r = await shipSteps($, await readEvents($, r))
    if (!r.on) return
    if ((r.holdStreak ?? 0) >= MAX_HOLD_STREAK) {
      const last = [...r.ships].reverse().find(s => s.state === 'held')
      await stopRun($, r, `${r.holdStreak} milestones in a row were held for one cause (${r.holdCause}), which every later milestone would hit too: ${(last?.note ?? '').slice(0, 200)}`)
      return
    }
    r = await pollWaits($, r)
    r = await watchdog($, r)
    if (!r.on) return
    r = (await linearSync($, r)).r
    await writeRecord($, r)

    // A pending CI is looked at again soon, between the ticks.
    const waiting = inFlight(r.ships)
    if (waiting?.state === 'ci' && r.ciMode === 'github' && !fastTick) {
      fastTick = true
      $.clock.after(CI_FAST_MS, () => {
        fastTick = false
        void tick($, caps, pollMs)
      })
    }

    await nextOrFinish($, r, caps)
  } catch (error) {
    failed = true
    tickFails++
    tickError = String(error).slice(0, 300)
    $.ui.log(`auto-claude: tick failed: ${tickError}`, { to: 'debug' })
    // Told once per streak; a tick that gets through starts the count again.
    if (tickFails === TICK_FAIL_TELL && activeRoot !== undefined) {
      await tell($, { root: activeRoot }, `every tick fails (${tickFails} in a row), so nothing moves: ${tickError.slice(0, 200)}`).catch(() => {})
    }
  } finally {
    if (!failed) {
      tickFails = 0
      tickError = undefined
    }
    ticking = false
  }
}

// What the loop did since the last look, from its log.
async function readEvents($: EngineInterface, r: AutoRecord): Promise<AutoRecord> {
  const logText = (await readText($, FILES(r.root).log)) ?? ''
  let read = readLog(logText, r.logOffset, r.logLast)
  // Held on the tick before too: no half-written file lasts a whole tick, so
  // the log was replaced (cleared by hand), and all of it is new.
  if (read.held === true && (r.logHeld ?? 0) >= 1) read = readLog(logText, 0)
  r = { ...r, logOffset: read.offset, logLast: read.last, logHeld: read.held === true ? (r.logHeld ?? 0) + 1 : 0 }
  for (const e of read.entries) {
    if (e.event === 'start' && e.branch !== undefined) {
      r = { ...r, started: r.started + 1, worktrees: { ...r.worktrees, [e.branch]: e.worktree ?? '' } }
      // A line that waited has started: its wait is over.
      if (e.goal !== undefined && r.waits?.[e.goal] !== undefined) {
        const { [e.goal]: _done, ...rest } = r.waits
        r = { ...r, waits: rest }
      }
      // It was stacked before it waited: its new branch carries the parent's commits too.
      const sha = e.goal === undefined ? undefined : r.waitOnto?.[e.goal]
      if (e.goal !== undefined && sha !== undefined) {
        const { [e.goal]: _moved, ...rest } = r.waitOnto ?? {}
        r = { ...r, onto: { ...r.onto, [e.branch]: sha }, waitOnto: rest }
      }
      const ids = e.goal === undefined ? [] : lineIssues(e.goal)
      if (r.linear !== undefined && r.buildOnly !== true && ids.length > 0) r = { ...r, linear: await onStart($, r.linear, ids) }
    } else if (e.event === 'met' && e.goal !== undefined && e.branch !== undefined) {
      r = { ...r, finished: r.finished + 1 }
      if (r.buildOnly !== true) r = await metToShip($, r, e.goal, e.branch)
    } else if (e.event === 'blocked' || e.event === 'deferred') {
      r = { ...r, held: r.held + 1, finished: r.finished + 1 }
      // A repair that could not be built: the stacked milestones go on, and their deploys count toward the stop.
      if (e.goal !== undefined && e.goal === r.repair) r = { ...r, repair: undefined }
      const parent: string | undefined = e.goal === undefined ? undefined : r.fixes[e.goal]
      if (parent !== undefined) r = { ...r, ships: r.ships.map((s): ShipItem => (s.headRef === parent ? { ...s, state: 'held', note: 'its fix goal was blocked' } : s)) }
      await tell($, r, `${e.event}: ${(e.goal ?? '').slice(0, 80)}${e.reason !== undefined ? ` (${e.reason.slice(0, 100)})` : ''}; going on`)
      const ids = e.goal === undefined ? [] : lineIssues(e.goal)
      if (r.linear !== undefined && r.buildOnly !== true && ids.length > 0) r = { ...r, linear: await onHeld($, r.linear, ids, `${e.event}${e.reason !== undefined ? `: ${e.reason}` : ''}`) }
    } else if (e.event === 'waiting') {
      // Back in the queue, waiting on its command: finished as a build, not held.
      r = { ...r, finished: r.finished + 1 }
      const sha = e.branch === undefined ? undefined : r.onto?.[e.branch]
      if (e.goal !== undefined && e.branch !== undefined && sha !== undefined) {
        const { [e.branch]: _left, ...rest } = r.onto ?? {}
        r = { ...r, onto: rest, waitOnto: { ...r.waitOnto, [e.goal]: sha } }
      }
      await tell($, r, `waiting: ${(e.goal ?? '').slice(0, 80)}${e.reason !== undefined ? ` (${e.reason.slice(0, 100)})` : ''}; auto-claude polls it and goes on with other milestones`)
    } else if (e.event === 'queue-empty') {
      r = { ...r, queueEmpty: true }
    }
  }
  return r
}

// A met milestone becomes a ship item; a met fix goal puts its milestone back to push.
async function metToShip($: EngineInterface, r: AutoRecord, goal: string, branch: string): Promise<AutoRecord> {
  const parent: string | undefined = r.fixes[goal]
  const wt: string | undefined = r.worktrees[branch]
  // A fix landed: its branch carries the PR's commits plus the fix.
  if (parent !== undefined) return { ...r, ships: r.ships.map((s): ShipItem => (s.headRef === parent ? { ...s, branch, worktree: wt, state: 'push', repeats: 0 } : s)) }
  const check: string | undefined = parseQueue((await readText($, FILES(r.root).queue)) ?? '').find(i => i.condition === goal)?.check
  // Built on a branch still shipping, or behind milestones still shipping: it
  // waits its turn, and is rebased onto the default branch before its push.
  const onto: string | undefined = r.onto?.[branch]
  const { [branch]: _taken, ...rest } = r.onto ?? {}
  // A deploy repair, built on the default branch, ships ahead of them all.
  const repair = goal === r.repair
  const state = !repair && (onto !== undefined || unfinished(r.ships).length > 0) ? 'stacked' : 'push'
  return { ...r, onto: rest, ships: [...r.ships, { goal, headRef: branch, branch, worktree: wt, check, state, red: 0, since: await $.clock.now(), ...(onto !== undefined ? { onto } : {}), ...(repair ? { repair: true } : {}) }] }
}

// A shipping error that keeps coming back goes to the session model with what
// was tried: it can fix what the driver cannot (gh auth, a remote, a branch).
async function askModel($: EngineInterface, r: AutoRecord, item: ShipItem): Promise<boolean> {
  // A milestone being built has the session: asked once it is done instead.
  if ((await readLoop($, r.root))?.current !== undefined) return false
  const text = [
    `[auto-claude] Shipping is stuck: "${item.goal.slice(0, 100)}"${item.pr !== undefined ? ` (PR #${item.pr})` : ''} has failed at ${item.state} ${item.repeats ?? 0} times in a row with:`,
    '```',
    (item.note ?? '').slice(0, 1500),
    '```',
    `Already tried by the driver: ${(item.tried ?? []).join(', ') || 'retrying each tick'}.`,
    'Find the cause and fix what you can from here (gh auth status, git remote -v, the branch on the remote, gh repo set-default, the PR itself). Do not merge or deploy: auto-claude retries on its own each tick, and holds this milestone and goes on if it still fails. Record what you found under ## Decisions in .claude/auto-plan.md, then end the turn.',
  ].join('\n')
  $.prompt.submit({ text }).catch(() => {})
  return true
}

// The watchdog: a milestone whose session sits idle is prompted again (3, 6,
// then 12 min of quiet), then blocked so the run goes on; a run where nothing
// moves is told to the person with what is being done about it.
async function watchdog($: EngineInterface, r: AutoRecord): Promise<AutoRecord> {
  if (!r.on || r.phase !== 'run') return r
  const now = await $.clock.now()
  const loop = await readLoop($, r.root)
  const current = loop?.current
  const quiet = current === undefined ? undefined : quietFor(now, current.startedAt)
  if (loop !== undefined && current !== undefined && quiet !== undefined) {
    const wakes = loop.wakes ?? 0
    if (wakeDue(quiet, wakes)) {
      if (wakes >= LOOP_WAKES) {
        await blockCurrent($, r.root, `the session did not work on it after ${wakes} prompts`)
      } else {
        await writeLoop($, { ...loop, wakes: wakes + 1 })
        await resumeLoop($, r.root, `the session sat idle ${Math.round(quiet / 60_000)} min with this milestone open; wake ${wakes + 1}/${LOOP_WAKES}`)
      }
    }
  }
  const sig = progressSig(r)
  if (sig !== r.sig || r.movedAt === undefined || isWaiting(r, now, quiet)) return { ...r, sig, movedAt: now, idleNudges: 0, idleNudgedAt: undefined }
  const n = idleDue(r, now)
  if (n === undefined) return r
  const why = diagnose(r, await stallFacts($, r)) ?? `nothing was started, shipped or merged`
  await tell($, r, `idle ${Math.round((now - r.movedAt) / 60_000)} min (${n}/${MAX_IDLE_NUDGES}): ${why}. The watchdog keeps retrying, holds what stays stuck, and goes on by itself.`)
  return { ...r, idleNudges: n, idleNudgedAt: now }
}

// A stop file left from an earlier run would end the new one at its first
// tick (measured: a run started over one stopped within 30 s). Starting or
// resuming is the person's word that the run should go, so the file is set
// aside, never deleted: .claude/auto-claude.stop.cleared keeps the last one.
async function clearStop($: EngineInterface, root: string): Promise<{ cleared: boolean } | { error: string }> {
  const stop = FILES(root).stop
  if (!(await $.fs.exists(stop).catch(() => false))) return { cleared: false }
  const moved = await run($, ['mv', '-f', stop, `${stop}.cleared`], root, 15_000)
  if (moved.exitCode !== 0) return { error: `a leftover .claude/auto-claude.stop could not be set aside (${out(moved)}); move it away and try again` }
  return { cleared: true }
}

const clearedNote = (c: { cleared: boolean }) => (c.cleared ? ' A leftover .claude/auto-claude.stop was moved to .claude/auto-claude.stop.cleared.' : '')

async function startCommand($: EngineInterface, hint: string, ciMode: string, buildOnly: boolean, alwaysOn = false): Promise<string> {
  const where = await sessionRoot($)
  let root = where.root
  const notes: string[] = []
  // Not a repository: the session's own directory becomes one (never an
  // ancestor found by walking up from a removed directory).
  if (root === undefined) {
    if (buildOnly) return notInRepo(where)
    if (where.used !== where.cwd) return notInRepo(where)
    const made = await bootstrapRepo($, where.cwd, false)
    if ('error' in made) return made.error
    root = made.root
    notes.push(made.note)
  }
  const existing = await readRecord($, root)
  if (existing?.on === true) return `A run is already on here (phase ${existing.phase}); /${COMMAND} status, or /${COMMAND} stop first.`
  if (buildOnly) {
    const queue = await readText($, FILES(root).queue)
    if (queue === undefined) return `No queue: write goals to ${FILES(root).queue}, one per line, e.g.\n- [ ] make add() return a + b :: check: pytest -q`
    if (!parseQueue(queue).some(i => i.mark === ' ')) return 'The queue has no pending goal.'
  }
  // A repository with no commit has nothing to branch milestones from.
  if ((await run($, ['git', '-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'], root, 15_000)).exitCode !== 0) {
    const made = await bootstrapRepo($, root, true)
    if ('error' in made) return made.error
    notes.push(made.note)
  }
  const hasOrigin = (await run($, ['git', '-C', root, 'remote'], root)).stdout.split('\n').some(s => s.trim() === 'origin')
  let remote = 'origin'
  let defaultBranch: string
  let mode: 'github' | 'local' = 'local'
  if (hasOrigin) {
    await run($, ['git', '-C', root, 'fetch', '-q', remote], root)
    const head = (await run($, ['git', '-C', root, 'symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], root)).stdout.trim()
    // origin/HEAD is set only by clone: a repository whose origin was added by
    // hand has none, and its default may well be master. The remote says.
    const asked = head.startsWith(`${remote}/`) ? undefined : (await run($, ['git', '-C', root, 'ls-remote', '--symref', remote, 'HEAD'], root, 30_000)).stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m)?.[1]
    defaultBranch = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : (asked ?? 'main')
    mode = ciMode === 'github' || ciMode === 'local' ? ciMode : (await run($, ['gh', 'repo', 'view', '--json', 'name'], root, 30_000)).exitCode === 0 ? 'github' : 'local'
  } else {
    // No origin: milestones land in this repository's own branch, checked by
    // their own checks. A push into the checked-out branch updates its files
    // in place, which needs a clean tree.
    if (ciMode === 'github' && !buildOnly) return 'Not started: github CI needs an `origin` remote, and this repository has none.'
    remote = LOCAL
    const branch = (await run($, ['git', '-C', root, 'symbolic-ref', '--short', 'HEAD'], root, 15_000)).stdout.trim()
    if (branch === '') return 'Not started: HEAD is detached, so there is no branch for milestones to land in; check one out.'
    defaultBranch = branch
    if (!buildOnly) {
      const dirty = (await run($, ['git', '-C', root, 'status', '--porcelain', '--untracked-files=no'], root, 30_000)).stdout.trim()
      if (dirty !== '') return `Not started: ${branch} has uncommitted changes, and milestones land in it in place; commit or stash them first.`
      await run($, ['git', '-C', root, 'config', 'receive.denyCurrentBranch', 'updateInstead'], root, 15_000)
      notes.push(`No remote: milestones land in ${branch} here, checked by their own checks.`)
    }
  }

  // Read once: what this run deploys cannot change while it runs. Without the
  // file, the plan's Deploy line decides, fixed when the plan is accepted.
  const deployText = buildOnly ? undefined : await readText($, `${root}/${DEPLOY_FILE}`)
  const deploy = deployText === undefined ? undefined : parseDeploy(deployText)
  if (deploy !== undefined && 'error' in deploy) return `Not started: ${deploy.error}.`

  const f = FILES(root)
  const logLines = ((await readText($, f.log)) ?? '').split('\n').filter(l => l.trim() !== '')
  await run($, ['mkdir', '-p', `${root}/.git/info`], root, 15_000)
  await ensureLines($, f.exclude, EXCLUDES, '# auto-claude')
  const stop = await clearStop($, root)
  if ('error' in stop) return `Not started: ${stop.error}.`
  await ensureLines($, f.deny, DENY, '# auto-claude: merging and releases are the driver\'s')
  const now = await $.clock.now()
  const r: AutoRecord = {
    on: true,
    phase: buildOnly ? 'run' : 'plan',
    root,
    sessionId: await $.session.id(),
    hint,
    round: 1,
    startedAt: now,
    remote,
    defaultBranch,
    ciMode: mode,
    logOffset: logLines.length,
    logLast: logLines.at(-1),
    started: 0,
    finished: 0,
    beatAt: now,
    phaseAt: now,
    nudges: 0,
    worktrees: {},
    ships: [],
    fixes: {},
    merges: 0,
    held: 0,
    queueEmpty: false,
    ...(buildOnly ? { buildOnly: true } : {}),
    ...(alwaysOn && !buildOnly ? { alwaysOn: true, cycle: 0 } : {}),
    ...(deploy === undefined ? {} : { deploy, deploys: 0 }),
  }
  // The Linear baseline first: a tick between two writes would lose it.
  const kick = buildOnly ? {} : await linearKickoff($, root)
  if (kick.linear !== undefined) r.linear = kick.linear
  activeRoot = root
  // A milestone left open by an earlier run belongs to that run's plan.
  await stopLoop($, root, true)
  await writeRecord($, r)
  clearSessionGoal($)
  if (buildOnly) {
    $.clock.after(100, () => void tickNow?.())
    return `auto-claude building the queue in ${root}: one worktree per pending line, judged by its check; nothing is pushed, merged or deployed.${clearedNote(stop)}`
  }
  const text = kickoffText(hint, refOf({ remote, defaultBranch }), remote === LOCAL, deploy?.command, kick.brief)
  $.clock.after(100, () => {
    $.prompt.submit({ text }).catch(() => $.ui.toast('auto-claude: the planning prompt was not submitted; send any message to start.'))
  })

  const moved = where.used === where.cwd ? '' : ` (the session's directory ${where.cwd} no longer exists; used ${where.used})`
  const deploys = deploy === undefined ? ', deploys as the plan says' : `, deploys after each merge with \`${deploy.command}\`${deploy.codeql.length > 0 ? ` after a CodeQL scan (${deploy.codeql.join(', ')})` : ''}`
  const always = r.alwaysOn === true ? ' Always on: once the final check passes, it stands by and wakes for new work.' : ''
  return `auto-claude on in ${root}${moved} (${mode} CI, merges into ${defaultBranch}${deploys}). Claude plans the run now.${always}${clearedNote(stop)}${notes.length > 0 ? ` ${notes.join(' ')}` : ''}`
}

async function stallFacts($: EngineInterface, r: AutoRecord): Promise<StallFacts> {
  const f = FILES(r.root)
  const planErrors = r.phase === 'plan' ? ((v => (v.ok ? [] : v.errors))(validatePlan(await readText($, f.plan), await readText($, f.queue), r.round === 1, r.deploy?.source === 'file'))) : []
  const now = await $.clock.now()
  const current = (await readLoop($, r.root))?.current
  const quietMs = current === undefined ? undefined : quietFor(now, current.startedAt)
  return {
    now,
    sessionId: await $.session.id(),
    staleMs: STALE_MS,
    planErrors,
    maxNudges: MAX_NUDGES,
    planWaitMs: PLAN_NUDGE_MS,
    ...(quietMs === undefined ? {} : { quietMs }),
    ...(r.movedAt === undefined ? {} : { idleMs: now - r.movedAt }),
    ...(tickFails >= TICK_FAIL_TELL && tickError !== undefined ? { tickFails, tickError } : {}),
  }
}

async function stallLine($: EngineInterface, r: AutoRecord): Promise<string | undefined> {
  const why = diagnose(r, await stallFacts($, r))
  return why === undefined ? undefined : `stalled: ${why}`
}

// The waiting lines, for status: what each waits on, since when, and its last poll.
async function waitLines($: EngineInterface, r: AutoRecord, queue: readonly QueueItem[]): Promise<string[]> {
  const now = await $.clock.now()
  return queue
    .filter(i => i.mark === ' ' && i.after !== undefined)
    .map(i => {
      const w = r.waits?.[i.condition]
      if (w === undefined) return `- waiting: ${i.condition.slice(0, 60)} on \`${i.after!.slice(0, 80)}\` (not polled yet)`
      if (w.ok === true) return `- wait over: ${i.condition.slice(0, 60)} (starts next)`
      const checked = w.checkedAt !== undefined ? `, last poll ${Math.round((now - w.checkedAt) / 60_000)} min ago` : ''
      return `- waiting ${hours(now - w.since)}: ${i.condition.slice(0, 60)} on \`${i.after!.slice(0, 80)}\`${checked}${(w.aliveFails ?? 0) > 0 ? `, alive failing ${w.aliveFails}x` : ''}`
    })
}

async function standbyStatus($: EngineInterface, r: AutoRecord): Promise<string> {
  const now = await $.clock.now()
  const dayMerges = `${recentMerges(r.mergeTimes, now).length}/${standbyCfg.maxMergesPerDay} merges in 24 h`
  if (r.phase !== 'standby') return `always on · cycle ${r.cycle ?? 0}${(r.wokeFor ?? []).length > 0 && (r.cycle ?? 0) > 0 ? ` (woke for ${r.wokeFor!.join(', ')})` : ''} · ${dayMerges} · stands by when the final check passes`
  const next = sourcesOf(r).map(s => `${s} in ${Math.max(0, Math.round(((r.timers?.[s] ?? now) - now) / 60_000))} min`)
  return `always on · standing by ${hours(now - (r.standbyAt ?? now))} after cycle ${r.cycle ?? 0} · wakes on ${sourceNames(r)}${next.length > 0 ? ` · next poll: ${next.join(', ')}` : ''} · ${dayMerges}${r.githubError !== undefined ? ` · github error: ${r.githubError}` : ''}`
}

async function statusText($: EngineInterface): Promise<string> {
  const root = activeRoot ?? (await sessionRoot($)).root
  const r = root === undefined ? undefined : await readRecord($, root)
  if (r === undefined) return 'No auto-claude run in this repository.'
  const queue = parseQueue((await readText($, FILES(r.root).queue)) ?? '')
  const current = (await readLoop($, r.root))?.current
  const deploys =
    r.deploy !== undefined
      ? `deploys after each merge: \`${r.deploy.command}\`${r.deploy.codeql.length > 0 ? ` (CodeQL ${r.deploy.codeql.join(', ')} first)` : ''}${r.deploy.smoke !== undefined ? `, smoke \`${r.deploy.smoke}\`` : ''} · ${r.deploys ?? 0} so far${r.deployDue === true ? ' · a deploy is due' : ''}`
      : r.deployNone !== undefined
        ? `deploys nothing: ${r.deployNone}`
        : undefined
  const lines = [
    `auto-claude ${r.on ? 'on' : 'off'} · phase ${r.phase} · round ${r.round} · ${r.buildOnly === true ? 'build only' : `${r.ciMode} CI into ${r.defaultBranch}`}`,
    deploys,
    `queue: ${queue.filter(i => i.mark === 'x').length} done, ${queue.filter(i => i.mark === '!').length} blocked, ${queue.filter(i => i.mark === ' ').length} pending · ${summary(r.merges, r.held, r.ships)}`,
    current !== undefined ? `building: ${current.condition.slice(0, 80)} (${current.branch})` : undefined,
    ...(await waitLines($, r, queue)),
    ...r.ships.filter(s => s.state !== 'merged').map(s => `- ${s.state}${s.pr !== undefined ? ` PR #${s.pr}` : ''}: ${s.goal.slice(0, 70)}${s.note ? ` (${s.note.slice(0, 80)})` : ''}`),
    r.linear !== undefined
      ? `linear: project ${r.linear.project} · ${Object.keys(r.linear.seen).length} issue(s) covered · last sync ${r.linear.syncedAt !== undefined ? `${Math.round(((await $.clock.now()) - r.linear.syncedAt) / 60_000)} min ago` : 'never'}${r.linear.error !== undefined ? ` · error: ${r.linear.error}` : ''}`
      : r.buildOnly === true ? undefined : 'linear: off (this folder maps to no project in ~/.claude/linear.json repo_mapping: add projectId or projectName)',
    r.alwaysOn === true ? await standbyStatus($, r) : undefined,
    r.note !== undefined ? `note: ${r.note}` : undefined,
    await stallLine($, r),
  ]
  return lines.filter((l): l is string => l !== undefined).join('\n')
}

// A run from before the loop merged into this plugin (goal-mode 0.7.0) kept
// its loop in goal-mode's store, which this plugin cannot read: the goal it
// was building is found again from the log (the last start with no end after it).
async function recoverLoop($: EngineInterface, r: AutoRecord): Promise<void> {
  if ((await readLoop($, r.root)) !== undefined) return
  const lines = ((await readText($, FILES(r.root).log)) ?? '').split('\n').filter(l => l.trim() !== '')
  let open: { goal: string; worktree?: string; branch: string } | undefined
  for (const line of lines) {
    let e: { event?: string; goal?: string; worktree?: string; branch?: string }
    try {
      e = JSON.parse(line) as typeof e
    } catch {
      continue
    }
    if (e.event === 'start' && e.goal !== undefined && e.branch !== undefined) open = { goal: e.goal, worktree: e.worktree, branch: e.branch }
    else if ((e.event === 'met' || e.event === 'blocked' || e.event === 'deferred' || e.event === 'waiting') && e.goal === open?.goal) open = undefined
  }
  if (open === undefined || open.worktree === undefined) {
    await writeLoop($, { repoRoot: r.root, seq: 0, retries: 0 })
    return
  }
  const check = parseQueue((await readText($, FILES(r.root).queue)) ?? '').find(i => i.condition === open?.goal)?.check
  await writeLoop($, { repoRoot: r.root, seq: 0, retries: 0, current: { condition: open.goal, check, worktree: open.worktree, branch: open.branch, startedAt: await $.clock.now() } })
  await resumeLoop($, r.root, 'auto-claude 1.0 took the loop over from goal-mode')
}

// Set at session start: a tick from a timer (a goal just finished, a build-only start).
let tickNow: (() => Promise<void>) | undefined

export const register: Register = (on, options) => {
  const caps: Caps = {
    maxRounds: Number(options.maxRounds ?? 3),
    maxMerges: Number(options.maxMerges ?? 20),
    maxHours: Number(options.maxHours ?? 24),
    maxWaitHours: Number(options.maxWaitHours ?? 72),
  }
  const pollMs = Math.max(Number(options.ciPollSec ?? 30), 5) * 1000
  const ciMode = typeof options.ciMode === 'string' ? options.ciMode : 'auto'
  const alwaysOnDefault = options.alwaysOn === true
  const minutes = (v: unknown, d: number) => Math.max(Number(v ?? d) || d, 1) * 60_000
  standbyCfg = {
    healthMs: minutes(options.healthEveryMin, 30),
    githubMs: minutes(options.githubEveryMin, 10),
    issueLabel: typeof options.issueLabel === 'string' ? options.issueLabel.trim() : 'auto-claude',
    maxMergesPerDay: Number(options.maxMergesPerDay ?? 20),
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: 'Unattended run of this repository: /auto-claude start [aim] | start --always-on [aim] | start --queue | standby | status | stop | resume' })
    await $.tool.register({
      name: READY_TOOL,
      description: 'auto-claude: call once .claude/auto-plan.md (with its Final check and Deploy lines) and .claude/goals.md (milestone lines with checks) are written. It validates them and starts or continues the run.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    await $.tool.register({
      name: DEFER_TOOL,
      description: `auto-claude run only: give up on the current milestone because of an external blocker (credentials, a human decision, missing access), so it is marked blocked and the run moves on. Allowed only after at least ${MIN_CHECKS_TO_DEFER} failed checks; stop right after calling it. Waiting on compute (training, a cache build) is not a blocker: use ${WAIT_TOOL_ID}.`,
      inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'The external blocker, in one or two sentences.' } }, required: ['reason'] },
      isDeferred: false,
    })
    await $.tool.register({
      name: WAIT_TOOL,
      description: 'auto-claude run only: the current milestone needs a job with its own clock to finish first (a training run, a cache build, a file another milestone lands). Commit, call this with a shell command that exits 0 once it is done, then end the turn. auto-claude polls it every few minutes, builds other milestones meanwhile, and restarts this one from its branch when it passes.',
      inputSchema: {
        type: 'object',
        properties: {
          until: { type: 'string', description: 'Shell command, run from the repository root (not the worktree), that exits 0 once what you wait for is done, e.g. grep -q "CACHE DONE" ~/data/m21/cache.log or git cat-file -e origin/main:docs/m22/final.json.' },
          alive: { type: 'string', description: 'Optional shell command that exits 0 while the awaited job still runs, e.g. tmux has-session -t m21cache. Failing twice in a row means it died, and you are asked to look.' },
          within: { type: 'string', description: 'Optional: how long it should take at most (90m, 12h, 2d). Past it you are asked to look; past twice it the milestone is held.' },
          reason: { type: 'string', description: 'What it waits for, in one sentence.' },
        },
        required: ['until', 'reason'],
      },
      isDeferred: false,
    })
    // A fresh load knows nothing of the turns before it: quiet counts from now.
    Object.assign(watch, { turnActive: false, lastTurnEndAt: undefined, judging: false, retryUntil: 0, loadedAt: await $.clock.now() })
    tickNow = () => tick($, caps, pollMs)
    setOnFinish(() => {
      $.clock.after(100, () => void tick($, caps, pollMs))
    })
    // A reload while the session sits in a removed worktree used to leave no root:
    // every tick returned at once, and the run stood still without a word.
    const root = await repoRoot($, await existingDir($, e.cwd)).catch(() => undefined)
    activeRoot = root
    const r = root === undefined ? undefined : await readRecord($, root)
    if (r?.on === true && r.phase === 'run' && r.sessionId === (await $.session.id())) await recoverLoop($, r).catch(() => undefined)
    // A run this session owned goes on after a reload; no run draws nothing,
    // which also takes down a piece an earlier load left.
    await show($, r)
    ticker?.cancel()
    ticker = $.clock.every(pollMs, () => void tick($, caps, pollMs))
    return started
  })

  // A piece never outlives its session: cleared at its end, by the ending id.
  on('session.end', async ($, e, next) => {
    await segment($, '', e.sessionId)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) watch.turnActive = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      watch.turnActive = false
      watch.lastTurnEndAt = await $.clock.now()
    }
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const r = activeRoot === undefined ? undefined : await readRecord($, activeRoot)
    // Only the session running it is unattended; another one has a person in it.
    if (!owns(r) || r!.sessionId !== (await $.session.id())) return composed
    const building = (await loopView($)) !== null
    return {
      ...composed,
      sections: [
        ...composed.sections,
        { id: 'auto-claude:policy', text: POLICY, scope: 'session' as const },
        ...(building ? [{ id: 'auto-claude:loop', text: LOOP_POLICY, scope: 'session' as const }] : []),
      ],
    }
  })

  // The Stop of a turn that builds a milestone: the loop judges it.
  on('classic.Stop', async ($, e, next) => {
    const below = await next(e)
    if (e.agent_id !== undefined || below.block !== undefined || below.preventContinuation === true) return below
    return onStop($, e, below)
  })

  // The SDK's Matcher over tool.call's input union is too deep for tsc (TS2589)
  // on the first matcher hook of the event; a stub handler reproduces it, so it
  // is the matcher's type, not this hook. Only this line is exempt.
  // @ts-expect-error TS2589 in claude-code's Matcher<Args<'tool.call'>>
  on('tool.call', { tool: DEFER_TOOL_ID }, async ($, e) => deferCall($, (e as unknown as { reason?: unknown }).reason))

  on('tool.call', { tool: WAIT_TOOL_ID }, async ($, e) => waitCall($, e as unknown as Record<string, unknown>))

  on('tool.call', { tool: READY_TOOL_ID }, async ($): Promise<{ result: string }> => {
    const root = activeRoot
    const r = root === undefined ? undefined : await readRecord($, root)
    if (r === undefined || !r.on) return { result: `No auto-claude run is on; /${COMMAND} start first.` }
    if (r.buildOnly === true) return { result: 'This run builds the queue only; it takes no plan.' }
    // Only a plan being made is accepted: a milestone's turn cannot re-fix what the run deploys.
    if (r.phase !== 'plan') return { result: `The plan was accepted already (phase ${r.phase}); keep building the milestone.` }
    const f = FILES(r.root)
    const fixed = r.deploy?.source === 'file'
    const verdict = validatePlan(await readText($, f.plan), await readText($, f.queue), r.round === 1, fixed)
    if (!verdict.ok) return { result: `Not ready; fix and call ${READY_TOOL} again:\n- ${verdict.errors.join('\n- ')}` }
    let next: AutoRecord = { ...r, phase: 'run', queueEmpty: false }
    let deployNote = ''
    if (!fixed && verdict.deploy !== undefined) {
      if (verdict.deploy.kind === 'command') {
        const spec = specOfPlan(verdict.deploy)
        const changed = r.deploy !== undefined && (r.deploy.command !== spec.command || r.deploy.smoke !== spec.smoke)
        next = { ...next, deploy: spec, deployNone: undefined, deploys: r.deploys ?? 0 }
        deployNote = `; ${changed ? 'deploy changed to' : 'deploys with'} \`${spec.command}\`, smoke \`${spec.smoke}\`${spec.codeql.length > 0 ? `, CodeQL ${spec.codeql.join(', ')}` : ''}`
      } else {
        next = { ...next, deploy: undefined, deployNone: verdict.deploy.reason }
        deployNote = `; deploys nothing (${verdict.deploy.reason})`
      }
    }
    await writeRecord($, next)
    await tell($, next, `round ${next.round} planned: ${verdict.pending.length} milestone(s); final check \`${verdict.finalCheck}\`${deployNote}`)
    $.clock.after(100, () => void tick($, caps, pollMs))
    return {
      result: `Plan accepted: ${verdict.pending.length} milestone(s), final check \`${verdict.finalCheck}\`${deployNote}. The first milestone starts as this turn ends; tell the person the plan in a few lines and end the turn.`,
    }
  })

  // Refusals: while a run is on in this session, and while a milestone is built in it.
  on('tool.call', async ($, e, next) => {
    const view = await loopView($)
    const r = activeRoot === undefined ? undefined : await readRecord($, activeRoot)
    const runOn = owns(r) && r!.sessionId === (await $.session.id())
    if (view === null && !runOn) return next(e)
    const refusal = guardRefusal(e as unknown as Record<string, unknown>, view, runOn)
    if (refusal === undefined) return next(e)
    if (view !== null) await appendLog($, view.repoRoot, { event: 'denied', tool: e.tool, reason: refusal })
    return { deny: refusal }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [action = 'status', ...rest] = e.args.trim().split(/\s+/).filter(w => w !== '')
    if (action === 'start') {
      const buildOnly = rest.includes('--queue')
      const alwaysOn = rest.includes('--always-on') || (alwaysOnDefault && !rest.includes('--once'))
      return { text: await startCommand($, rest.filter(w => w !== '--queue' && w !== '--always-on' && w !== '--once').join(' '), ciMode, buildOnly, alwaysOn) }
    }
    if (action === 'status') return { text: await statusText($) }
    const root = activeRoot ?? (await sessionRoot($)).root
    const r = root === undefined ? undefined : await readRecord($, root)
    if (r === undefined) return { text: 'No auto-claude run in this repository.' }
    if (action === 'stop') {
      if (!r.on) return { text: 'The run is not on.' }
      await stopRun($, r, 'stopped by the person')
      return { text: `Stopped. ${summary(r.merges, r.held, r.ships)}` }
    }
    if (action === 'standby') {
      // A run going on stands by once its final check passes; one that
      // finished stands by now, owned by this session.
      if (r.buildOnly === true) return { text: 'A build-only run (--queue) does not stand by.' }
      if (r.on && r.phase !== 'standby') {
        await writeRecord($, { ...r, alwaysOn: true, cycle: r.cycle ?? 0 })
        return { text: `Always on: once the final check passes, the run stands by and wakes for new work.` }
      }
      if (r.phase !== 'done' && r.phase !== 'standby') return { text: `The run was ${r.phase}; /${COMMAND} resume goes on with it (as always on after this), or /${COMMAND} start begins a new one.` }
      if (r.on && r.sessionId === (await $.session.id())) return { text: 'The run already stands by in this session.' }
      const stop = await clearStop($, r.root)
      if ('error' in stop) return { text: `Not standing by: ${stop.error}.` }
      activeRoot = r.root
      orphanTold = undefined
      const now = await $.clock.now()
      await enterStandby($, { ...r, alwaysOn: true, cycle: r.cycle ?? 0, sessionId: await $.session.id(), beatAt: now }, `standby asked by the person`)
      return { text: `Standing by in ${r.root}: wakes on ${sourceNames(r)}.${clearedNote(stop)}` }
    }
    if (action === 'resume') {
      if (r.on && r.sessionId === (await $.session.id())) return { text: 'The run is already on in this session.' }
      const stop = await clearStop($, r.root)
      if ('error' in stop) return { text: `Not resumed: ${stop.error}.` }
      const now = await $.clock.now()
      const phase = r.phase === 'done' || r.phase === 'stopped' || r.phase === 'final' ? (r.pausedPhase ?? 'run') : r.phase
      // A run that stood by stands by again: nothing was being built.
      if (phase === 'standby') {
        const stop = await clearStop($, r.root)
        if ('error' in stop) return { text: `Not resumed: ${stop.error}.` }
        activeRoot = r.root
        orphanTold = undefined
        await enterStandby($, { ...r, sessionId: await $.session.id(), beatAt: await $.clock.now() }, 'resumed by the person')
        return { text: `Resumed: standing by, cycle ${r.cycle ?? 0}.${clearedNote(stop)}` }
      }
      // A run still planning gets its prompt again, with Linear read before the record is written.
      const kick = phase === 'plan' ? await linearKickoff($, r.root) : {}
      const next: AutoRecord = {
        ...r,
        on: true,
        phase,
        sessionId: await $.session.id(),
        startedAt: now,
        beatAt: now,
        holdStreak: 0,
        deployFails: 0,
        ...(phase === 'plan' ? { phaseAt: now, nudges: 0 } : {}),
        ...(kick.linear !== undefined ? { linear: kick.linear } : {}),
      }
      activeRoot = r.root
      orphanTold = undefined
      await writeRecord($, next)
      clearSessionGoal($)
      if (phase === 'plan') {
        const text = kickoffText(r.hint, refOf(r), r.remote === LOCAL, r.deploy?.source === 'file' ? r.deploy.command : undefined, kick.brief)
        $.clock.after(100, () => {
          $.prompt.submit({ text }).catch(() => $.ui.toast('auto-claude: the planning prompt was not submitted; send any message to start.'))
        })
      } else {
        // The goal it was building, taken over here (a loop from goal-mode is found in its log).
        await recoverLoop($, next).catch(() => undefined)
        await resumeLoop($, r.root, 'resumed by the person')
      }
      return { text: `Resumed: phase ${next.phase}, round ${next.round}.${clearedNote(stop)}` }
    }
    return { text: `Usage: /${COMMAND} start [aim] | start --always-on [aim] | start --queue | standby | status | stop | resume` }
  })
}
