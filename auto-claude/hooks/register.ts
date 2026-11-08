import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AutoRecord, ShipItem } from '../types'
import { fixLine, kickoffText, parseQueue, planNudgeText, POLICY, READY_TOOL, replanText, validatePlan } from './plan'
import { segment } from './segment'
import { codeqlSuite, countSarif, DEPLOY_FILE, parseDeploy } from './deploy'
import type { DeploySpec } from './deploy'
import { capReached, diagnose, gateCredit, idleDue, inFlight, isWaiting, MAX_IDLE_NUDGES, MAX_RED, mergeable, parseChecks, prNumber, progressSig, readLog, repoSlug, summary } from './ship'
import type { StallFacts } from './ship'
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
const EXCLUDES = ['.claude/auto-plan.md', '.claude/auto-claude.stop', '.claude/auto-claude.stop.cleared']
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
// While a PR's CI is pending it is looked at this often, between the ticks.
const CI_FAST_MS = 10_000
// Ready steps one tick takes a milestone through (push, PR, CI, landing).
const MAX_STEPS = 4
// A PR that reports no checks yet may only be slow to register them: it is
// waited on this long before "no checks" means the repository has no CI.
const NO_CI_GRACE_MS = 90_000

let ticker: Timer | undefined
let ticking = false
// A fast look at a pending CI is already scheduled.
let fastTick = false
let activeRoot: string | undefined
// The owner an orphaned run was last reported for, once per session.
let orphanTold: string | undefined
// Ticks failed in a row and the last error: a tick that throws every time
// (an unwritable gate, a broken store) moves nothing and must not stay silent.
let tickFails = 0
let tickError: string | undefined
const TICK_FAIL_TELL = 3

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

// A repository with no remote lands its milestones in its own default branch: its "remote" is itself.
const LOCAL = '.'
const refOf = (r: { remote: string; defaultBranch: string }, branch = r.defaultBranch) => (r.remote === LOCAL ? branch : `${r.remote}/${branch}`)
async function fetchRemote($: EngineInterface, r: { remote: string }, cwd: string): Promise<void> {
  if (r.remote !== LOCAL) await run($, ['git', '-C', cwd, 'fetch', '-q', r.remote], cwd)
}

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
}

async function repoRoot($: EngineInterface, cwd: string): Promise<string | undefined> {
  const r = await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, 15_000)
  const common = r.stdout.trim()
  return r.exitCode === 0 && common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : undefined
}

// The repository of the session's directory, or of its nearest ancestor that
// still exists. A session that cd'ed into a milestone's worktree keeps it as
// its directory after auto-claude removes that worktree. git cannot even
// start in a missing directory (Bun: "posix_spawn 'git' ENOENT"), and that
// used to read as "Not inside a git repository".
async function sessionRoot($: EngineInterface): Promise<{ root?: string; cwd: string; used: string }> {
  const cwd = await $.session.cwd()
  let dir = cwd
  while (dir !== '/' && !(await $.fs.exists(dir).catch(() => true))) dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  return { root: await repoRoot($, dir), cwd, used: dir }
}

const notInRepo = (s: { cwd: string; used: string }) =>
  s.used === s.cwd
    ? `Not inside a git repository: ${s.cwd}.`
    : `Not inside a git repository: the session's directory ${s.cwd} no longer exists, and ${s.used} is not in one.`

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
  if (readLog((await readText($, f.log)) ?? '', r.logOffset, r.logLast).entries.some(e => e.event === 'start')) return r
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
  // gh is told which repository the branch was pushed to (see repoSlug).
  const slug = r.remote === LOCAL ? undefined : repoSlug((await run($, ['git', '-C', wt, 'remote', 'get-url', r.remote], wt, 15_000)).stdout)
  const repo = slug === undefined ? [] : ['--repo', slug]

  if (item.state === 'push') {
    if (r.ciMode === 'local') return { r, item: update({ state: 'ci' }) }
    const pushed = await run($, ['git', '-C', wt, 'push', '-u', r.remote, `${item.branch}:${item.headRef}`, ...(item.branch !== item.headRef ? ['--force-with-lease'] : [])], wt)
    if (pushed.exitCode !== 0) return { r, item: update({ note: `push failed: ${out(pushed)}` }) }
    if (item.pr !== undefined) return { r, item: update({ state: 'ci', since: await $.clock.now() }) }
    const made = await run($, ['gh', 'pr', 'create', ...repo, '--head', item.headRef, '--base', r.defaultBranch, '--title', item.goal.slice(0, 120), '--body', `Milestone of an auto-claude run.\n\nCheck: \`${item.check ?? '-'}\`\n\nPlan: .claude/auto-plan.md (local to the run).`], wt)
    const pr = prNumber(made.stdout + made.stderr)
    if (pr === undefined) return { r, item: update({ note: `gh pr create failed: ${out(made)}` }) }
    await tell($, r, `opened PR #${pr}: ${item.goal.slice(0, 80)}`)
    return { r, item: update({ state: 'ci', pr, since: await $.clock.now() }) }
  }

  if (item.state !== 'ci') return { r, item }

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
    const checks = parseChecks((await run($, ['gh', 'pr', 'checks', String(item.pr), ...repo, '--json', 'bucket'], wt)).stdout)
    if (checks === 'pending') return { r, item }
    // Asked right after the PR was opened, GitHub has usually not registered
    // its checks yet: that is pending too, until the grace runs out.
    if (checks === 'none' && (await $.clock.now()) - item.since < NO_CI_GRACE_MS) return { r, item }
    if (checks === 'red') failure = 'CI failed (gh pr checks)'
    if (failure === undefined) {
      // Looked at again right before merging.
      const state = mergeable((await run($, ['gh', 'pr', 'view', String(item.pr), ...repo, '--json', 'state,mergeable'], wt)).stdout)
      if (state.unknown) return { r, item }
      // A merge whose reply was lost (a 502 after GitHub merged it) has landed.
      if (state.merged) {
        // Fall through to the merged bookkeeping below.
      } else if (!state.open) return { r, item: update({ state: 'held', note: 'the PR is no longer open' }) }
      else if (state.conflict) failure = `conflicts with ${r.defaultBranch}`
      else {
        // CI judged the PR; the milestone's own check is judged on the pushed head too.
        await run($, ['git', '-C', r.root, 'fetch', '-q', r.remote, item.headRef], r.root)
        failure = await verifyFresh($, r, item, `${r.remote}/${item.headRef}`)
      }
      if (failure === undefined && !state.merged) {
        const merged = await run($, ['gh', 'pr', 'merge', String(item.pr), ...repo, '--squash', '--delete-branch'], wt)
        if (merged.exitCode !== 0) return { r, item: update({ note: `merge failed: ${out(merged)}` }) }
      }
    }
  }

  if (failure === undefined) {
    // The milestone's worktrees go; a dirty one stays for a look.
    for (const path of new Set([item.worktree, r.worktrees[item.headRef]].filter((p): p is string => p !== undefined))) {
      await run($, ['git', '-C', r.root, 'worktree', 'remove', path], r.root)
    }
    let next: AutoRecord = { ...r, merges: r.merges + 1 }
    const landed = item.pr !== undefined ? `PR #${item.pr}` : `into ${r.defaultBranch}`
    await tell($, next, `merged ${landed}: ${item.goal.slice(0, 80)}`)
    const merged = update({ state: 'merged', note: undefined })
    if (r.deploy !== undefined) {
      const failed = await deployMerged($, next, r.deploy)
      // What is live may now differ from what was merged: no more merges on top of it.
      if (failed !== undefined) return { r: await stopRun($, next, `the deploy after ${landed} failed: ${failed}`), item: merged }
      next = { ...next, deploys: (next.deploys ?? 0) + 1 }
      await tell($, next, `deployed after ${landed}`)
    }
    return { r: next, item: merged }
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

// Deploys what the default branch now holds, from a fresh detached checkout of
// it. Returns why it failed, or undefined.
async function deployMerged($: EngineInterface, r: AutoRecord, spec: DeploySpec): Promise<string | undefined> {
  const dir = `${r.root}/worktrees/auto-deploy`
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  await fetchRemote($, r, r.root)
  const made = await run($, ['git', '-C', r.root, 'worktree', 'add', '--detach', dir, refOf(r)], r.root)
  if (made.exitCode !== 0) return `no checkout of ${refOf(r)}: ${out(made)}`
  try {
    for (const language of spec.codeql) {
      const blocked = await codeqlGate($, r, dir, language)
      if (blocked !== undefined) return blocked
    }
    const ran = await run($, ['bash', '-lc', spec.command], dir, spec.timeoutMs)
    return ran.exitCode === 0 ? undefined : `\`${spec.command}\` exited ${ran.exitCode}: ${out(ran)}`
  } finally {
    await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  }
}

// CodeQL before a deploy (CLAUDE.md §5): any error-level result blocks it.
// The database and SARIF stay outside the repository, in $TMPDIR.
async function codeqlGate($: EngineInterface, r: AutoRecord, dir: string, language: string): Promise<string | undefined> {
  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  const name = `${r.root.split('/').pop() ?? 'repo'}-${language}`
  const db = `${tmp}/auto-claude-codeql-${name}`
  const sarif = `${tmp}/auto-claude-codeql-${name}.sarif`
  const created = await run($, ['codeql', 'database', 'create', db, `--language=${language}`, '--source-root', dir, '--overwrite'], dir, 600_000)
  if (created.exitCode !== 0) return `CodeQL could not build a ${language} database: ${out(created)}`
  const analyzed = await run($, ['codeql', 'database', 'analyze', db, codeqlSuite(language), '--format=sarif-latest', `--output=${sarif}`], dir, 600_000)
  if (analyzed.exitCode !== 0) return `CodeQL ${language} analysis failed: ${out(analyzed)}`
  const counted = countSarif((await readText($, sarif)) ?? '')
  if (counted === undefined) return `CodeQL wrote no readable SARIF at ${sarif}`
  if (counted.errors > 0) return `CodeQL found ${counted.errors} error-level result(s) in ${language} (${counted.top.join('; ')}); SARIF at ${sarif}`
  if (counted.warnings > 0) await tell($, r, `CodeQL ${language}: ${counted.warnings} warning(s), no errors; SARIF at ${sarif}`)
  return undefined
}

async function finalCheck($: EngineInterface, r: AutoRecord, caps: Caps): Promise<AutoRecord> {
  const plan = await readText($, FILES(r.root).plan)
  const verdict = validatePlan(plan, (await readText($, FILES(r.root).queue)) ?? '', false)
  const check = verdict.ok ? verdict.finalCheck : plan === undefined ? undefined : (plan.match(/final check\s*:\s*`?([^`\n]+)/i)?.[1] ?? undefined)
  if (check === undefined) return stopRun($, r, 'auto-plan.md lost its final check')
  // Judged on what was merged: a fresh detached checkout of the default branch.
  const dir = `${r.root}/worktrees/auto-final`
  await run($, ['git', '-C', r.root, 'worktree', 'remove', '--force', dir], r.root)
  await fetchRemote($, r, r.root)
  const made = await run($, ['git', '-C', r.root, 'worktree', 'add', '--detach', dir, refOf(r)], r.root)
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
  let failed = false
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
    // The engine's clock, like every other time the run keeps (beatAt, phaseAt, movedAt).
    const cap = capReached(r, caps, await $.clock.now())
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
    const { entries, offset, last } = readLog((await readText($, FILES(r.root).log)) ?? '', r.logOffset, r.logLast)
    r = { ...r, logOffset: offset, logLast: last }
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
          r = { ...r, ships: [...r.ships, { goal: e.goal, headRef: e.branch, branch: e.branch, worktree: r.worktrees[e.branch], check, state: 'push', red: 0, since: await $.clock.now() }] }
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

    // Every step that is ready runs now, not one per tick: a milestone met
    // with its CI already green is pushed, opened, landed and followed by the
    // next grant in this one tick (measured before: ~90 s of a 2.5 min gap
    // was waiting for ticks).
    for (let steps = 0; steps < MAX_STEPS; steps++) {
      const item = inFlight(r.ships)
      if (item === undefined || item.state === 'fixing') break
      const step = await advance($, r, item)
      // The same error tick after tick (measured: a git that would not spawn,
      // retried for the whole 24 h cap) is told once.
      const same = step.item.note !== undefined && step.item.note === item.note && step.item.state === item.state
      const repeats = same ? (item.repeats ?? 0) + 1 : 0
      if (repeats === REPEAT_TELL) await tell($, step.r, `stuck at ${item.state} for ${repeats} checks: ${(step.item.note ?? '').slice(0, 160)}`)
      r = { ...step.r, ships: step.r.ships.map(s => (s.headRef === item.headRef ? { ...step.item, repeats } : s)) }
      // Waiting (CI pending, an error to retry): the next tick looks again.
      if (step.item.state === item.state) break
    }
    r = await idleCheck($, r)
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

    // Nothing shipping: let the loop take its next goal (a fix goal included).
    const busy = inFlight(r.ships)
    if (busy === undefined || busy.state === 'fixing') {
      if (r.queueEmpty && busy === undefined && r.phase === 'run') {
        await finalCheck($, { ...r, phase: 'final' }, caps)
      } else if (r.phase === 'run') {
        const pending = parseQueue((await readText($, FILES(r.root).queue)) ?? '').some(i => i.mark === ' ')
        if (pending) {
          // The grant and its loop on in the same tick: release only asks.
          const released = await release($, { ...r, queueEmpty: false }, pollMs)
          if (released.want === 'on') await runWanted($, released)
        }
      }
    }
  } catch (error) {
    failed = true
    tickFails++
    tickError = String(error).slice(0, 300)
    $.ui.log(`auto-claude: tick failed: ${tickError}`, { to: 'debug' })
    // Told once per streak; a tick that gets through starts the count again.
    if (tickFails === TICK_FAIL_TELL && activeRoot !== undefined) {
      await tell($, { root: activeRoot } as AutoRecord, `every tick fails (${tickFails} in a row), so nothing moves: ${tickError.slice(0, 200)}`).catch(() => {})
    }
  } finally {
    if (!failed) {
      tickFails = 0
      tickError = undefined
    }
    ticking = false
  }
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

// Lines a bootstrapped repository ignores before its first commit: secrets and
// noise must not enter a history auto-claude then builds on.
const BOOTSTRAP_IGNORE = ['.env', '.env.*', '!.env.example', '*.pem', '*.key', '*.p12', '*.pfx', 'node_modules/', '.DS_Store', 'worktrees/', '.claude/settings.local.json']
// A directory with more files than this, or other repositories inside it, is not one project.
const BOOTSTRAP_MAX_FILES = 3000

// A directory that is not a git repository (or has one with no commit yet) is
// made into one: `git init` on main, a .gitignore for secrets, one initial
// commit of what is there. Returns why it will not, for a directory that is
// plainly not a single project (the home directory, a folder of repositories).
async function bootstrapRepo($: EngineInterface, dir: string, hasRepo: boolean): Promise<{ root: string; note: string } | { error: string }> {
  const home = (await $.env.get('HOME').catch(() => undefined))?.replace(/\/$/, '')
  if (dir === '/' || dir === home) return { error: `Not a project directory: ${dir}. cd into the project's folder and start there.` }
  const nested = (await run($, ['bash', '-c', 'find . -mindepth 2 -maxdepth 3 -name .git -not -path "./worktrees/*" | head -1'], dir, 30_000)).stdout.trim()
  if (nested !== '') return { error: `Not bootstrapped: ${dir} holds other repositories (${nested}); start inside one of them.` }
  const counted = (await run($, ['bash', '-c', `find . -type f -not -path "./.git/*" -not -path "*/node_modules/*" | head -${BOOTSTRAP_MAX_FILES + 1} | wc -l`], dir, 60_000)).stdout.trim()
  if (Number(counted) > BOOTSTRAP_MAX_FILES) return { error: `Not bootstrapped: ${dir} holds more than ${BOOTSTRAP_MAX_FILES} files, so it is not one project; start in the project's folder, or run git init yourself.` }
  if (!hasRepo) {
    let init = await run($, ['git', '-C', dir, 'init', '-b', 'main'], dir, 30_000)
    // git before 2.28 has no -b.
    if (init.exitCode !== 0) {
      init = await run($, ['git', '-C', dir, 'init'], dir, 30_000)
      if (init.exitCode === 0) await run($, ['git', '-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/main'], dir, 15_000)
    }
    if (init.exitCode !== 0) return { error: `Not bootstrapped: git init failed in ${dir}: ${out(init)}` }
  }
  const root = await repoRoot($, dir)
  if (root === undefined) return { error: `Not bootstrapped: ${dir} is still not a git repository after git init.` }
  await ensureLines($, `${root}/.gitignore`, BOOTSTRAP_IGNORE, '# auto-claude bootstrap')
  await run($, ['git', '-C', root, 'add', '-A'], root, 60_000)
  const staged = (await run($, ['git', '-C', root, 'diff', '--cached', '--name-only'], root, 30_000)).stdout.split('\n').filter(l => l.trim() !== '').length
  const made = await run($, ['git', '-C', root, 'commit', '--allow-empty', '-m', 'Initial commit'], root, 60_000)
  if (made.exitCode !== 0) return { error: `Not bootstrapped: the initial commit failed (is git user.name / user.email set?): ${out(made)}` }
  return { root, note: `${hasRepo ? 'Made the first commit' : 'Initialized a git repository'} here (main, ${staged} file${staged === 1 ? '' : 's'}; secrets and noise are in .gitignore).` }
}

async function startCommand($: EngineInterface, hint: string, ciMode: string): Promise<string> {
  const where = await sessionRoot($)
  let root = where.root
  const notes: string[] = []
  // Not a repository: the session's own directory becomes one (never an
  // ancestor found by walking up from a removed directory).
  if (root === undefined) {
    if (where.used !== where.cwd) return notInRepo(where)
    const made = await bootstrapRepo($, where.cwd, false)
    if ('error' in made) return made.error
    root = made.root
    notes.push(made.note)
  }
  const existing = await readRecord($, root)
  if (existing?.on === true) return `A run is already on here (phase ${existing.phase}); /${COMMAND} status, or /${COMMAND} stop first.`
  // A repository with no commit has nothing to branch milestones from.
  if ((await run($, ['git', '-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'], root, 15_000)).exitCode !== 0) {
    const made = await bootstrapRepo($, root, true)
    if ('error' in made) return made.error
    notes.push(made.note)
  }
  const hasOrigin = (await run($, ['git', '-C', root, 'remote'], root)).stdout.split('\n').some(s => s.trim() === 'origin')
  let remote = 'origin'
  let defaultBranch = 'main'
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
    if (ciMode === 'github') return 'Not started: github CI needs an `origin` remote, and this repository has none.'
    remote = LOCAL
    const branch = (await run($, ['git', '-C', root, 'symbolic-ref', '--short', 'HEAD'], root, 15_000)).stdout.trim()
    if (branch === '') return 'Not started: HEAD is detached, so there is no branch for milestones to land in; check one out.'
    defaultBranch = branch
    const dirty = (await run($, ['git', '-C', root, 'status', '--porcelain', '--untracked-files=no'], root, 30_000)).stdout.trim()
    if (dirty !== '') return `Not started: ${branch} has uncommitted changes, and milestones land in it in place; commit or stash them first.`
    await run($, ['git', '-C', root, 'config', 'receive.denyCurrentBranch', 'updateInstead'], root, 15_000)
    notes.push(`No remote: milestones land in ${branch} here, checked by their own checks.`)
  }

  // Read once: what this run deploys cannot change while it runs.
  const deployText = await readText($, `${root}/${DEPLOY_FILE}`)
  const deploy = deployText === undefined ? undefined : parseDeploy(deployText)
  if (deploy !== undefined && 'error' in deploy) return `Not started: ${deploy.error}.`

  const f = FILES(root)
  const logLines = ((await readText($, f.log)) ?? '').split('\n').filter(l => l.trim() !== '')
  await run($, ['mkdir', '-p', `${root}/.git/info`], root, 15_000)
  await ensureLines($, f.exclude, EXCLUDES, '# auto-claude')
  const stop = await clearStop($, root)
  if ('error' in stop) return `Not started: ${stop.error}.`
  await ensureLines($, f.deny, DENY, '# auto-claude: merging and releases are the driver\'s')
  await $.fs.write(f.base, `${refOf({ remote, defaultBranch })}\n`)
  // Closed until the plan is ready.
  const r: AutoRecord = {
    on: true,
    phase: 'plan',
    root,
    sessionId: await $.session.id(),
    hint,
    round: 1,
    startedAt: await $.clock.now(),
    remote,
    defaultBranch,
    ciMode: mode,
    logOffset: logLines.length,
    logLast: logLines.at(-1),
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
    ...(deploy === undefined ? {} : { deploy, deploys: 0 }),
  }
  await $.fs.write(f.gate, '0\n')
  activeRoot = root
  await writeRecord($, r)
  const text = `${kickoffText(hint, refOf({ remote, defaultBranch }), remote === LOCAL)}${deploy === undefined ? '' : `\n- auto-claude deploys after each merge (${DEPLOY_FILE}). Plan no deploy milestone and never deploy yourself.`}`
  $.clock.after(100, () => {
    $.prompt.submit({ text }).catch(() => $.ui.toast('auto-claude: the planning prompt was not submitted; send any message to start.'))
  })

  const moved = where.used === where.cwd ? '' : ` (the session's directory ${where.cwd} no longer exists; used ${where.used})`
  const deploys = deploy === undefined ? '' : `, deploys after each merge with \`${deploy.command}\`${deploy.codeql.length > 0 ? ` after a CodeQL scan (${deploy.codeql.join(', ')})` : ''}`
  return `auto-claude on in ${root}${moved} (${mode} CI, merges into ${defaultBranch}${deploys}). Claude plans the run now.${clearedNote(stop)}${notes.length > 0 ? ` ${notes.join(' ')}` : ''}`
}

async function stallFacts($: EngineInterface, r: AutoRecord): Promise<StallFacts> {
  const f = FILES(r.root)
  const planErrors = r.phase === 'plan' ? ((v => (v.ok ? [] : v.errors))(validatePlan(await readText($, f.plan), await readText($, f.queue), r.round === 1))) : []
  const now = await $.clock.now()
  return {
    now,
    sessionId: await $.session.id(),
    staleMs: STALE_MS,
    credit: gateCredit(await readText($, f.gate)),
    planErrors,
    maxNudges: MAX_NUDGES,
    planWaitMs: PLAN_NUDGE_MS,
    ...(r.movedAt === undefined ? {} : { idleMs: now - r.movedAt }),
    ...(tickFails >= TICK_FAIL_TELL && tickError !== undefined ? { tickFails, tickError } : {}),
  }
}

async function stallLine($: EngineInterface, r: AutoRecord): Promise<string | undefined> {
  const why = diagnose(r, await stallFacts($, r))
  return why === undefined ? undefined : `stalled: ${why}`
}

// A run that stays idle is told to the person again and again (the shipping
// error's one note after 10 ticks was missed: a run sat 2 h at a PR that would
// not open). Each nudge names the cause and, where the loop is the one that
// is idle, asks it to start again. Progress, or waiting on a clock of its own
// (a goal being built, a PR's CI), starts the count over.
async function idleCheck($: EngineInterface, r: AutoRecord): Promise<AutoRecord> {
  if (!r.on || r.phase !== 'run') return r
  const now = await $.clock.now()
  const sig = progressSig(r)
  if (sig !== r.sig || r.movedAt === undefined || isWaiting(r, now)) return { ...r, sig, movedAt: now, idleNudges: 0, idleNudgedAt: undefined }
  const n = idleDue(r, now)
  if (n === undefined) return r
  const why = diagnose(r, await stallFacts($, r)) ?? `idle ${Math.round((now - r.movedAt) / 60_000)} min`
  // A shipping step that fails retries every tick already. When the loop is the idle one, clearing kickedAt
  // lets `release` (this same tick) grant and ask at once, past its backoff; the tries and what was told stay.
  const item = inFlight(r.ships)
  const heal = item === undefined || item.state === 'fixing'
  const last = n >= MAX_IDLE_NUDGES ? ' No more nudges; /auto-claude status keeps the stalled line.' : ''
  await tell($, r, `idle ${Math.round((now - r.movedAt) / 60_000)} min (nudge ${n}/${MAX_IDLE_NUDGES}): ${why}.${heal ? ' Asking the loop to start again.' : ''} /auto-claude status for detail; /auto-claude resume re-grants and re-asks.${last}`)
  return { ...r, idleNudges: n, idleNudgedAt: now, ...(heal ? { kickedAt: undefined } : {}) }
}

async function statusText($: EngineInterface): Promise<string> {
  const root = activeRoot ?? (await sessionRoot($)).root
  const r = root === undefined ? undefined : await readRecord($, root)
  if (r === undefined) return 'No auto-claude run in this repository.'
  const queue = parseQueue((await readText($, FILES(r.root).queue)) ?? '')
  const lines = [
    `auto-claude ${r.on ? 'on' : 'off'} · phase ${r.phase} · round ${r.round} · ${r.ciMode} CI into ${r.defaultBranch}`,
    r.deploy !== undefined ? `deploys after each merge: \`${r.deploy.command}\`${r.deploy.codeql.length > 0 ? ` (CodeQL ${r.deploy.codeql.join(', ')} first)` : ''} · ${r.deploys ?? 0} so far` : undefined,
    `queue: ${queue.filter(i => i.mark === 'x').length} done, ${queue.filter(i => i.mark === '!').length} blocked, ${queue.filter(i => i.mark === ' ').length} pending · ${summary(r.merges, r.held, r.ships)}`,
    ...r.ships.filter(s => s.state !== 'merged').map(s => `- ${s.state}${s.pr !== undefined ? ` PR #${s.pr}` : ''}: ${s.goal.slice(0, 70)}${s.note ? ` (${s.note.slice(0, 80)})` : ''}`),
    r.note !== undefined ? `note: ${r.note}` : undefined,
    await stallLine($, r),
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
    // A run this session owned goes on after a reload; no run draws nothing,
    // which also takes down a piece an earlier load left.
    await show($, root === undefined ? undefined : await readRecord($, root))
    ticker?.cancel()
    ticker = $.clock.every(pollMs, () => void tick($, caps, pollMs))
    return started
  })

  // A piece never outlives its session: cleared at its end, by the ending id.
  on('session.end', async ($, e, next) => {
    await segment($, '', e.sessionId)
    return next(e)
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
    const root = activeRoot ?? (await sessionRoot($)).root
    const r = root === undefined ? undefined : await readRecord($, root)
    if (r === undefined) return { text: 'No auto-claude run in this repository.' }
    if (action === 'stop') {
      if (!r.on) return { text: 'The run is not on.' }
      await stopRun($, r, 'stopped by the person')
      return { text: `Stopped. ${summary(r.merges, r.held, r.ships)}` }
    }
    if (action === 'resume') {
      if (r.on && r.sessionId === (await $.session.id())) return { text: 'The run is already on in this session.' }
      const stop = await clearStop($, r.root)
      if ('error' in stop) return { text: `Not resumed: ${stop.error}.` }
      const now = await $.clock.now()
      const phase = r.phase === 'done' || r.phase === 'stopped' || r.phase === 'final' ? ('run' as const) : r.phase
      // A run still planning gets its prompt again.
      const next: AutoRecord = {
        ...r,
        on: true,
        phase,
        sessionId: await $.session.id(),
        startedAt: now,
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
        const text = kickoffText(r.hint, refOf(r), r.remote === LOCAL)
        $.clock.after(100, () => {
          $.prompt.submit({ text }).catch(() => $.ui.toast('auto-claude: the planning prompt was not submitted; send any message to start.'))
        })
      }
      return { text: `Resumed: phase ${next.phase}, round ${next.round}.${clearedNote(stop)}` }
    }
    return { text: `Usage: /${COMMAND} start [aim] | status | stop | resume` }
  })
}
