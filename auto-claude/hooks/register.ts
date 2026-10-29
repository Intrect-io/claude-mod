import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AutoRecord, ShipItem } from '../types'
import { fixLine, kickoffText, parseQueue, planNudgeText, POLICY, READY_TOOL, replanText, validatePlan } from './plan'
import { segment } from './segment'
import { capReached, gateCredit, inFlight, MAX_RED, mergeable, parseChecks, prNumber, readLog, summary } from './ship'
import type { Caps } from './ship'

// auto-claude: an unattended run of one repository, driven on top of
// goal-mode's loop. Claude plans the long-term end state and its milestones
// (.claude/auto-plan.md, .claude/goals.md); the loop builds each milestone in
// its own worktree and judges it; this module ships it (push, PR, CI, merge
// when green), one at a time through the loop's gate, and replans when the
// queue empties before the final check passes. Shipping runs here, through
// $.process.run, never as a model turn, and the model is denied merging.

const COMMAND = 'auto-claude'
const STORE = (root: string) => `auto:${root}`
const FILES = (root: string) => ({
  plan: `${root}/.claude/auto-plan.md`,
  queue: `${root}/.claude/goals.md`,
  log: `${root}/.claude/goal-loop.log`,
  deny: `${root}/.claude/goal-loop.deny`,
  base: `${root}/.claude/goal-loop.base`,
  gate: `${root}/.claude/goal-loop.gate`,
  stop: `${root}/.claude/auto-claude.stop`,
  exclude: `${root}/.git/info/exclude`,
})
const EXCLUDES = ['.claude/auto-plan.md', '.claude/auto-claude.stop']
const DENY = ['\\bgh\\s+pr\\s+merge\\b', '\\bgh\\s+release\\b', '\\bgit\\s+push\\b.*\\bHEAD:(main|master)\\b']

// A run whose owning session has not ticked for this long is orphaned.
const STALE_MS = 10 * 60_000
// `loop on` runs that start nothing before the person is told, and the longest wait between them.
const MAX_KICKS = 3
const KICK_WAIT_MAX_MS = 30 * 60_000
// A run still planning is reminded this often, this many times, then stopped.
const PLAN_NUDGE_MS = 15 * 60_000
const MAX_NUDGES = 3
// Ticks one shipping error may repeat before the person is told.
const REPEAT_TELL = 10

let ticker: Timer | undefined
let ticking = false
let activeRoot: string | undefined
// The owner an orphaned run was last reported for, once per session.
let orphanTold: string | undefined

type Run = { exitCode: number; stdout: string; stderr: string }

async function run($: EngineInterface, argv: string[], cwd: string, timeoutMs = 120_000): Promise<Run> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: String(error) }
  }
}

const out = (r: Run) => (r.stderr.trim() || r.stdout.trim()).slice(0, 400)

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

async function readRecord($: EngineInterface, root: string): Promise<AutoRecord | undefined> {
  const v = await $.store.get(STORE(root))
  return typeof v === 'object' && v !== null ? (v as AutoRecord) : undefined
}

async function writeRecord($: EngineInterface, r: AutoRecord): Promise<void> {
  await $.store.set(STORE(r.root), r)
  await show($, r)
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
  const pr = inFlight(r.ships)?.pr
  await segment($, `auto·R${r.round}·${r.phase === 'plan' ? 'plan' : `M${done}/${total}`}${pr !== undefined ? `·PR#${pr}` : ''}`)
}

async function tell($: EngineInterface, r: AutoRecord, text: string): Promise<void> {
  const line = `auto-claude (${r.root.split('/').pop()}): ${text}`
  $.ui.toast(line.slice(0, 200))
  try {
    await $.ui.notify(line, { title: 'auto-claude' })
  } catch {
    // No notification channel.
  }
  // The fleet dashboard's repo channel, where the fleet mod is installed.
  try {
    await $.tool.call({ tool: 'mcp__fleet__fleet_post', channel: '#all', text: line } as never)
  } catch {
    // No fleet.
  }
}

async function repoRoot($: EngineInterface, cwd: string): Promise<string | undefined> {
  const r = await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, 15_000)
  const common = r.stdout.trim()
  return r.exitCode === 0 && common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : undefined
}

async function ensureLines($: EngineInterface, path: string, lines: readonly string[], header: string): Promise<void> {
  const text = (await readText($, path)) ?? ''
  const have = new Set(text.split('\n').map(l => l.trim()))
  const missing = lines.filter(l => !have.has(l))
  if (missing.length === 0) return
  const head = text === '' || text.endsWith('\n') ? text : `${text}\n`
  await $.fs.write(path, `${head}${header}\n${missing.join('\n')}\n`)
}

// goal-loop.gate is a credit: granting 1 lets the loop start exactly one more
// goal, whatever its own seq (which carries over from earlier runs); `loop on`
// takes it. The command runs from the tick (measured: a timer set inside a
// tool call never ran it), so release only asks for it.
async function release($: EngineInterface, r: AutoRecord, pollMs: number): Promise<AutoRecord> {
  // Only while the loop is idle: a goal it is still building is not done yet.
  if (r.finished < r.started) return r
  const f = FILES(r.root)
  // goal-mode logs a start before it spends the credit: the gate is read
  // first and the log after, so a spent gate is never mistaken for an idle loop.
  const credit = gateCredit(await readText($, f.gate)) ?? 0
  if (readLog((await readText($, f.log)) ?? '', r.logOffset).entries.some(e => e.event === 'start')) return r
  if (credit <= 0) {
    await $.fs.write(f.gate, '1\n')
    const next: AutoRecord = { ...r, want: 'on' }
    await writeRecord($, next)
    return next
  }
  // Granted but not taken: `loop on` did not start it (a goal in the way,
  // another owner, a refused command). Ask again, backing off, and tell the
  // person once with what the loop answered.
  if (r.want !== undefined) return r
  const kicks = r.kicks ?? 0
  const wait = Math.min(2 * pollMs * 2 ** Math.max(kicks - 1, 0), KICK_WAIT_MAX_MS)
  if ((await $.clock.now()) - (r.kickedAt ?? 0) < wait) return r
  let next: AutoRecord = { ...r, want: 'on' }
  if (kicks >= MAX_KICKS && r.kickTold !== true) {
    const reply = (r.kickReply ?? 'no reply').replace(/\s+/g, ' ').slice(0, 200)
    await tell($, r, `the loop does not take the next milestone after ${kicks} tries of /goal-mode loop on: ${reply}`)
    next = { ...next, kickTold: true, note: `/goal-mode loop on starts nothing: ${reply}` }
  }
  await writeRecord($, next)
  return next
}

// The loop command a hook asked for, run from the tick's own timer. Its reply
// is kept: whether it started anything shows in the log, not here.
async function runWanted($: EngineInterface, r: AutoRecord): Promise<AutoRecord> {
  if (r.want === undefined) return r
  const args = r.want === 'on' ? 'loop on' : 'loop off'
  let reply: string | undefined
  try {
    reply = (await $.command.run({ command: 'goal-mode', args } as never)).text
  } catch (error) {
    $.ui.log(`auto-claude: /goal-mode ${args} failed: ${String(error).slice(0, 200)}`, { to: 'debug' })
    reply = `failed: ${String(error)}`
  }
  const kick = r.want === 'on' ? { kicks: (r.kicks ?? 0) + 1, kickedAt: await $.clock.now(), kickReply: reply?.slice(0, 300) } : {}
  const next: AutoRecord = { ...r, want: undefined, ...kick }
  await writeRecord($, next)
  return next
}

// Another session owns the run. Once its ticks stop, the run is stuck there:
// say so here, once, instead of staying silent.
async function reportOrphan($: EngineInterface, r: AutoRecord): Promise<void> {
  if (!r.on || r.sessionId === undefined || orphanTold === r.sessionId) return
  const quiet = (await $.clock.now()) - (r.beatAt ?? r.startedAt)
  if (quiet < STALE_MS) return
  orphanTold = r.sessionId
  await segment($, 'auto·orphaned')
  await tell($, r, `the session running it went quiet ${Math.round(quiet / 60_000)} min ago, so nothing moves; /${COMMAND} resume in this session to go on, or /${COMMAND} stop`)
}

async function stopRun($: EngineInterface, r: AutoRecord, why: string, phase: 'stopped' | 'done' = 'stopped'): Promise<AutoRecord> {
  const next: AutoRecord = { ...r, on: false, phase, note: why, want: 'off' }
  // No gate left behind to hold a loop the person runs later by hand.
  await $.fs.write(FILES(r.root).gate, '')
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

// One step of a milestone through push, CI and merge.
async function advance($: EngineInterface, r: AutoRecord, item: ShipItem): Promise<{ r: AutoRecord; item: ShipItem }> {
  const update = (patch: Partial<ShipItem>) => ({ ...item, ...patch })
  if (item.state !== 'push' && item.state !== 'ci') return { r, item }
  const where = await worktreeOf($, r, item)
  if ('gone' in where) {
    await tell($, r, `held: ${item.goal.slice(0, 60)} (${where.gone})`)
    return { r: { ...r, held: r.held + 1 }, item: update({ state: 'held', note: where.gone }) }
  }
  const wt = where.wt

  if (item.state === 'push') {
    if (r.ciMode === 'local') return { r, item: update({ state: 'ci' }) }
    const pushed = await run($, ['git', '-C', wt, 'push', '-u', r.remote, `${item.branch}:${item.headRef}`, ...(item.branch !== item.headRef ? ['--force-with-lease'] : [])], wt)
    if (pushed.exitCode !== 0) return { r, item: update({ note: `push failed: ${out(pushed)}` }) }
    if (item.pr !== undefined) return { r, item: update({ state: 'ci', since: Date.now() }) }
    const made = await run($, ['gh', 'pr', 'create', '--head', item.headRef, '--base', r.defaultBranch, '--title', item.goal.slice(0, 120), '--body', `Milestone of an auto-claude run.\n\nCheck: \`${item.check ?? '-'}\`\n\nPlan: .claude/auto-plan.md (local to the run).`], wt)
    const pr = prNumber(made.stdout + made.stderr)
    if (pr === undefined) return { r, item: update({ note: `gh pr create failed: ${out(made)}` }) }
    await tell($, r, `opened PR #${pr}: ${item.goal.slice(0, 80)}`)
    return { r, item: update({ state: 'ci', pr, since: Date.now() }) }
  }

  if (item.state !== 'ci') return { r, item }

  let failure: string | undefined
  if (r.ciMode === 'local') {
    if (item.check !== undefined) {
      const checked = await run($, ['bash', '-lc', item.check], wt, 600_000)
      if (checked.exitCode !== 0) failure = `check failed: ${out(checked)}`
    }
    if (failure === undefined) {
      await run($, ['git', '-C', wt, 'fetch', '-q', r.remote], wt)
      const rebased = await run($, ['git', '-C', wt, 'rebase', `${r.remote}/${r.defaultBranch}`], wt)
      if (rebased.exitCode !== 0) {
        await run($, ['git', '-C', wt, 'rebase', '--abort'], wt)
        failure = `does not rebase onto ${r.defaultBranch}: ${out(rebased)}`
      } else {
        const pushed = await run($, ['git', '-C', wt, 'push', r.remote, `HEAD:${r.defaultBranch}`], wt)
        if (pushed.exitCode !== 0) failure = `push to ${r.defaultBranch} failed: ${out(pushed)}`
      }
    }
  } else {
    const checks = parseChecks((await run($, ['gh', 'pr', 'checks', String(item.pr), '--json', 'bucket'], wt)).stdout)
    if (checks === 'pending') return { r, item }
    if (checks === 'red') failure = 'CI failed (gh pr checks)'
    if (failure === undefined) {
      // Looked at again right before merging.
      const state = mergeable((await run($, ['gh', 'pr', 'view', String(item.pr), '--json', 'state,mergeable'], wt)).stdout)
      if (state.unknown) return { r, item }
      if (!state.open) return { r, item: update({ state: 'held', note: 'the PR is no longer open' }) }
      if (state.conflict) failure = `conflicts with ${r.defaultBranch}`
      else {
        const merged = await run($, ['gh', 'pr', 'merge', String(item.pr), '--squash', '--delete-branch'], wt)
        if (merged.exitCode !== 0) return { r, item: update({ note: `merge failed: ${out(merged)}` }) }
      }
    }
  }

  if (failure === undefined) {
    // The milestone's worktrees go; a dirty one stays for a look.
    for (const path of new Set([item.worktree, r.worktrees[item.headRef]].filter((p): p is string => p !== undefined))) {
      await run($, ['git', '-C', r.root, 'worktree', 'remove', path], r.root)
    }
    const next = { ...r, merges: r.merges + 1 }
    await tell($, next, `merged${item.pr !== undefined ? ` PR #${item.pr}` : ` into ${r.defaultBranch}`}: ${item.goal.slice(0, 80)}`)
    return { r: next, item: update({ state: 'merged', note: undefined }) }
  }

  const red = item.red + 1
  if (red >= MAX_RED) {
    await tell($, r, `held after ${red} failures: ${item.goal.slice(0, 60)} (${failure.slice(0, 120)})`)
    return { r: { ...r, held: r.held + 1 }, item: update({ state: 'held', red, note: failure }) }
  }
  // A fix goal on top of the milestone's branch; the loop picks it up next.
  const line = fixLine(item.goal, item.pr, failure, item.check, item.branch)
  const condition = parseQueue(line)[0]!.condition
  const queue = (await readText($, FILES(r.root).queue)) ?? ''
  await $.fs.write(FILES(r.root).queue, `${queue}${queue === '' || queue.endsWith('\n') ? '' : '\n'}${line}\n`)
  return { r: { ...r, fixes: { ...r.fixes, [condition]: item.headRef } }, item: update({ state: 'fixing', red, note: failure }) }
}

async function finalCheck($: EngineInterface, r: AutoRecord, caps: Caps): Promise<AutoRecord> {
  const plan = await readText($, FILES(r.root).plan)
  const verdict = validatePlan(plan, (await readText($, FILES(r.root).queue)) ?? '', false)
  const check = verdict.ok ? verdict.finalCheck : plan === undefined ? undefined : (plan.match(/final check\s*:\s*`?([^`\n]+)/i)?.[1] ?? undefined)
  if (check === undefined) return stopRun($, r, 'auto-plan.md lost its final check')
  // Judged on what was merged: a fresh detached checkout of the default branch.
  const dir = `${r.root}/worktrees/auto-final`
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  await run($, ['git', '-C', r.root, 'fetch', '-q', r.remote], r.root)
  const made = await run($, ['git', '-C', r.root, 'worktree', 'add', '--detach', dir, `${r.remote}/${r.defaultBranch}`], r.root)
  const ran = made.exitCode === 0 ? await run($, ['bash', '-lc', check], dir, 600_000) : made
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  if (ran.exitCode === 0) {
    const plan2 = (await readText($, FILES(r.root).plan)) ?? ''
    await $.fs.write(FILES(r.root).plan, `${plan2.trimEnd()}\n\n## Result\n\nFinished ${new Date().toISOString()}: round ${r.round}, ${summary(r.merges, r.held, r.ships)}. Final check passed: \`${check}\`.\n`)
    return stopRun($, r, `the final check passed after ${r.round} round(s)`, 'done')
  }
  if (r.round >= caps.maxRounds) return stopRun($, r, `the final check still fails after ${r.round} round(s)`)
  const next: AutoRecord = { ...r, phase: 'plan', round: r.round + 1, queueEmpty: false, phaseAt: await $.clock.now(), nudges: 0 }
  await writeRecord($, next)
  const text = replanText(next.round, check, `${ran.stdout}\n${ran.stderr}`)
  $.clock.after(100, () => {
    $.prompt.submit({ text }).catch(() => {})
  })
  return next
}

async function tick($: EngineInterface, caps: Caps, pollMs: number): Promise<void> {
  if (ticking || activeRoot === undefined) return
  ticking = true
  try {
    const got = await readRecord($, activeRoot)
    if (got === undefined) return
    if (got.sessionId !== (await $.session.id())) {
      await reportOrphan($, got)
      return
    }
    // A stop asked the loop off: that still runs once the run is off.
    if (!got.on) {
      if (got.want === 'off') await runWanted($, got)
      return
    }
    let r: AutoRecord = { ...(await runWanted($, got)), beatAt: await $.clock.now() }
    // A record from before the gate was a credit held an absolute count there.
    if (r.credit !== true) {
      await $.fs.write(FILES(r.root).gate, '0\n')
      r = { ...r, credit: true }
    }
    if ((await readText($, FILES(r.root).stop)) !== undefined) {
      await stopRun($, r, '.claude/auto-claude.stop appeared')
      return
    }
    const cap = capReached(r, caps, Date.now())
    if (cap !== undefined) {
      await stopRun($, r, cap)
      return
    }

    // Planning is a model turn that may never end in auto_plan_ready (a
    // question nobody answers, a dropped prompt): remind, then give up.
    if (r.phase === 'plan') {
      const now = await $.clock.now()
      if (now - (r.phaseAt ?? now) >= PLAN_NUDGE_MS || r.phaseAt === undefined) {
        const nudges = r.phaseAt === undefined ? 0 : (r.nudges ?? 0) + 1
        if (nudges > MAX_NUDGES) {
          await stopRun($, r, `no plan was accepted after ${MAX_NUDGES} reminders`)
          return
        }
        r = { ...r, phaseAt: now, nudges }
        if (nudges > 0) {
          const f = FILES(r.root)
          const verdict = validatePlan(await readText($, f.plan), await readText($, f.queue), r.round === 1)
          $.prompt.submit({ text: planNudgeText(nudges, MAX_NUDGES, verdict.ok ? [] : verdict.errors) }).catch(() => {})
        }
      }
      await writeRecord($, r)
      return
    }

    // What the loop did since the last look.
    const { entries, offset } = readLog((await readText($, FILES(r.root).log)) ?? '', r.logOffset)
    r = { ...r, logOffset: offset }
    for (const e of entries) {
      if (e.event === 'start' && e.branch !== undefined) {
        r = { ...r, started: r.started + 1, worktrees: { ...r.worktrees, [e.branch]: e.worktree ?? '' }, kicks: 0, kickTold: false, kickReply: undefined, ...(r.kickTold === true ? { note: undefined } : {}) }
      } else if (e.event === 'met' && e.goal !== undefined && e.branch !== undefined) {
        r = { ...r, finished: r.finished + 1 }
        const parent: string | undefined = r.fixes[e.goal]
        if (parent !== undefined) {
          // A fix landed: its branch carries the PR's commits plus the fix.
          const wt: string | undefined = r.worktrees[e.branch]
          const branch: string = e.branch
          r = { ...r, ships: r.ships.map((s): ShipItem => (s.headRef === parent ? { ...s, branch, worktree: wt, state: 'push' } : s)) }
        } else {
          const check: string | undefined = parseQueue((await readText($, FILES(r.root).queue)) ?? '').find(i => i.condition === e.goal)?.check
          r = { ...r, ships: [...r.ships, { goal: e.goal, headRef: e.branch, branch: e.branch, worktree: r.worktrees[e.branch], check, state: 'push', red: 0, since: Date.now() }] }
        }
      } else if (e.event === 'blocked' || e.event === 'deferred') {
        r = { ...r, held: r.held + 1, finished: r.finished + 1 }
        const parent: string | undefined = e.goal === undefined ? undefined : r.fixes[e.goal]
        if (parent !== undefined) r = { ...r, ships: r.ships.map((s): ShipItem => (s.headRef === parent ? { ...s, state: 'held', note: 'its fix goal was blocked' } : s)) }
        await tell($, r, `${e.event}: ${(e.goal ?? '').slice(0, 80)}`)
      } else if (e.event === 'queue-empty') {
        r = { ...r, queueEmpty: true }
      }
    }

    const item = inFlight(r.ships)
    if (item !== undefined && item.state !== 'fixing') {
      const step = await advance($, r, item)
      // The same error tick after tick (measured: a git that would not spawn,
      // retried for the whole 24 h cap) is told once.
      const same = step.item.note !== undefined && step.item.note === item.note && step.item.state === item.state
      const repeats = same ? (item.repeats ?? 0) + 1 : 0
      if (repeats === REPEAT_TELL) await tell($, step.r, `stuck at ${item.state} for ${repeats} checks: ${(step.item.note ?? '').slice(0, 160)}`)
      r = { ...step.r, ships: step.r.ships.map(s => (s.headRef === item.headRef ? { ...step.item, repeats } : s)) }
    }
    await writeRecord($, r)

    // Nothing shipping: let the loop take its next goal (a fix goal included).
    const busy = inFlight(r.ships)
    if (busy === undefined || busy.state === 'fixing') {
      if (r.queueEmpty && busy === undefined && r.phase === 'run') {
        await finalCheck($, { ...r, phase: 'final' }, caps)
      } else if (r.phase === 'run') {
        const pending = parseQueue((await readText($, FILES(r.root).queue)) ?? '').some(i => i.mark === ' ')
        if (pending) await release($, { ...r, queueEmpty: false }, pollMs)
      }
    }
  } catch (error) {
    $.ui.log(`auto-claude: tick failed: ${String(error).slice(0, 300)}`, { to: 'debug' })
  } finally {
    ticking = false
  }
}

async function startCommand($: EngineInterface, hint: string, ciMode: string): Promise<string> {
  const root = await repoRoot($, await $.session.cwd())
  if (root === undefined) return 'Not inside a git repository.'
  const existing = await readRecord($, root)
  if (existing?.on === true) return `A run is already on here (phase ${existing.phase}); /${COMMAND} status, or /${COMMAND} stop first.`
  const remote = (await run($, ['git', '-C', root, 'remote'], root)).stdout.split('\n').map(s => s.trim()).find(s => s === 'origin') ?? undefined
  if (remote === undefined) return 'This repository has no `origin` remote: auto-claude ships milestones there.'
  await run($, ['git', '-C', root, 'fetch', '-q', remote], root)
  const head = (await run($, ['git', '-C', root, 'symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], root)).stdout.trim()
  const defaultBranch = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : 'main'
  const mode = ciMode === 'github' || ciMode === 'local' ? ciMode : (await run($, ['gh', 'repo', 'view', '--json', 'name'], root, 30_000)).exitCode === 0 ? 'github' : 'local'

  const f = FILES(root)
  await ensureLines($, f.exclude, EXCLUDES, '# auto-claude')
  await ensureLines($, f.deny, DENY, '# auto-claude: merging and releases are the driver\'s')
  await $.fs.write(f.base, `${remote}/${defaultBranch}\n`)
  // Closed until the plan is ready.
  const r: AutoRecord = {
    on: true,
    phase: 'plan',
    root,
    sessionId: await $.session.id(),
    hint,
    round: 1,
    startedAt: Date.now(),
    remote,
    defaultBranch,
    ciMode: mode,
    logOffset: ((await readText($, f.log)) ?? '').split('\n').filter(l => l.trim() !== '').length,
    started: 0,
    finished: 0,
    credit: true,
    beatAt: await $.clock.now(),
    phaseAt: await $.clock.now(),
    nudges: 0,
    worktrees: {},
    ships: [],
    fixes: {},
    merges: 0,
    held: 0,
    queueEmpty: false,
  }
  await $.fs.write(f.gate, '0\n')
  activeRoot = root
  await writeRecord($, r)
  const text = kickoffText(hint, `${remote}/${defaultBranch}`)
  $.clock.after(100, () => {
    $.prompt.submit({ text }).catch(() => $.ui.toast('auto-claude: the planning prompt was not submitted; send any message to start.'))
  })

  return `auto-claude on in ${root} (${mode} CI, merges into ${defaultBranch}). Claude plans the run now.`
}

async function statusText($: EngineInterface): Promise<string> {
  const root = activeRoot ?? (await repoRoot($, await $.session.cwd()))
  const r = root === undefined ? undefined : await readRecord($, root)
  if (r === undefined) return 'No auto-claude run in this repository.'
  const queue = parseQueue((await readText($, FILES(r.root).queue)) ?? '')
  const lines = [
    `auto-claude ${r.on ? 'on' : 'off'} · phase ${r.phase} · round ${r.round} · ${r.ciMode} CI into ${r.defaultBranch}`,
    `queue: ${queue.filter(i => i.mark === 'x').length} done, ${queue.filter(i => i.mark === '!').length} blocked, ${queue.filter(i => i.mark === ' ').length} pending · ${summary(r.merges, r.held, r.ships)}`,
    ...r.ships.filter(s => s.state !== 'merged').map(s => `- ${s.state}${s.pr !== undefined ? ` PR #${s.pr}` : ''}: ${s.goal.slice(0, 70)}${s.note ? ` (${s.note.slice(0, 80)})` : ''}`),
    r.note !== undefined ? `note: ${r.note}` : undefined,
  ]
  return lines.filter((l): l is string => l !== undefined).join('\n')
}

export const register: Register = (on, options) => {
  const caps: Caps = {
    maxRounds: Number(options.maxRounds ?? 3),
    maxMerges: Number(options.maxMerges ?? 20),
    maxHours: Number(options.maxHours ?? 24),
  }
  const pollMs = Math.max(Number(options.ciPollSec ?? 30), 5) * 1000
  const ciMode = typeof options.ciMode === 'string' ? options.ciMode : 'auto'

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: 'Unattended run of this repository: /auto-claude start [aim] | status | stop | resume' })
    await $.tool.register({
      name: READY_TOOL,
      description: 'auto-claude: call once .claude/auto-plan.md (with its Final check line) and .claude/goals.md (milestone lines with checks) are written. It validates them and starts or continues the run.',
      inputSchema: { type: 'object', properties: {} },
      isDeferred: false,
    })
    const root = await repoRoot($, e.cwd).catch(() => undefined)
    activeRoot = root
    // A run this session owned goes on after a reload.
    if (root !== undefined) await show($, await readRecord($, root))
    ticker?.cancel()
    ticker = $.clock.every(pollMs, () => void tick($, caps, pollMs))
    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const r = activeRoot === undefined ? undefined : await readRecord($, activeRoot)
    // Only the session running it is unattended; another one has a person in it.
    if (r === undefined || !r.on || r.sessionId !== (await $.session.id())) return composed
    return { ...composed, sections: [...composed.sections, { id: 'auto-claude:policy', text: POLICY, scope: 'session' as const }] }
  })

  on('tool.call', { tool: `mcp__auto-claude__${READY_TOOL}` }, async $ => {
    const root = activeRoot
    const r = root === undefined ? undefined : await readRecord($, root)
    if (r === undefined || !r.on) return { result: `No auto-claude run is on; /${COMMAND} start first.` }
    const f = FILES(r.root)
    const verdict = validatePlan(await readText($, f.plan), await readText($, f.queue), r.round === 1)
    if (!verdict.ok) return { result: `Not ready; fix and call ${READY_TOOL} again:\n- ${verdict.errors.join('\n- ')}` }
    const next = await release($, { ...r, phase: 'run', queueEmpty: false }, pollMs)
    await tell($, next, `round ${next.round} planned: ${verdict.pending.length} milestone(s); final check \`${verdict.finalCheck}\``)
    return {
      result: `Plan accepted: ${verdict.pending.length} milestone(s), final check \`${verdict.finalCheck}\`. goal-mode's loop starts the first one as this turn ends; tell the person the plan in a few lines and end the turn.`,
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [action = 'status', ...rest] = e.args.trim().split(/\s+/).filter(w => w !== '')
    if (action === 'start') return { text: await startCommand($, rest.join(' '), ciMode) }
    if (action === 'status') return { text: await statusText($) }
    const root = activeRoot ?? (await repoRoot($, await $.session.cwd()))
    const r = root === undefined ? undefined : await readRecord($, root)
    if (r === undefined) return { text: 'No auto-claude run in this repository.' }
    if (action === 'stop') {
      if (!r.on) return { text: 'The run is not on.' }
      await stopRun($, r, 'stopped by the person')
      return { text: `Stopped. ${summary(r.merges, r.held, r.ships)}` }
    }
    if (action === 'resume') {
      if (r.on && r.sessionId === (await $.session.id())) return { text: 'The run is already on in this session.' }
      const now = await $.clock.now()
      const phase = r.phase === 'done' || r.phase === 'stopped' || r.phase === 'final' ? ('run' as const) : r.phase
      // A run still planning gets its prompt again.
      const next: AutoRecord = {
        ...r,
        on: true,
        phase,
        sessionId: await $.session.id(),
        startedAt: Date.now(),
        beatAt: now,
        kicks: 0,
        kickTold: false,
        // The next tick grants a start and asks the loop on (or resumes its goal).
        kickedAt: undefined,
        ...(phase === 'plan' ? { phaseAt: now, nudges: 0 } : {}),
      }
      activeRoot = r.root
      orphanTold = undefined
      await writeRecord($, next)
      if (phase === 'plan') {
        const text = kickoffText(r.hint, `${r.remote}/${r.defaultBranch}`)
        $.clock.after(100, () => {
          $.prompt.submit({ text }).catch(() => $.ui.toast('auto-claude: the planning prompt was not submitted; send any message to start.'))
        })
      }
      return { text: `Resumed: phase ${next.phase}, round ${next.round}.` }
    }
    return { text: `Usage: /${COMMAND} start [aim] | status | stop | resume` }
  })
}
