import { atom, read, update } from 'claude-code'
import { segment } from './segment'
import type { EngineInterface, ModelForkResult, Register } from 'claude-code'

import type { Goal, GoalMeta, LoopView } from '../types'
import { checkBash, checkPath, uncommitted } from './guard'
import { markItem, nextPending, parseQueue, slugify, summarize } from './queue'

// Self-set goal mode: the model sets a session goal with `set_goal`, and at
// every Stop an independent evaluator decides whether the goal is met; while
// it is not, the stop is blocked and the model keeps working. When Claude
// Code's own ProposeGoal tool is available, the model is told to use it and
// `set_goal` refuses, so two evaluators never run at once.
//
// Loop mode (/goal-mode loop on) feeds goals from <repo>/.claude/goals.md one
// after another, each in its own git worktree, with the queue's check run by
// the plugin itself, retries with a change of approach, and guards on what an
// unattended session may run. Only the Stop hook advances the queue.

const TOOL = 'set_goal'
const TOOL_ID = 'mcp__goal-mode__set_goal'
const DEFER_TOOL = 'defer_goal'
const DEFER_TOOL_ID = 'mcp__goal-mode__defer_goal'
const COMMAND = 'goal-mode'
const NATIVE_TOOL = 'ProposeGoal'

const EVALUATOR_MODEL = 'claude-sonnet-5-5'
const EVALUATOR_TIMEOUT_MS = 60_000
const MAX_CONDITION_CHARS = 600
// Auto-declaration: a prompt shorter than this, a question, or a slash command
// is never classified; the classifier gives up after the timeout.
const AUTO_GOAL_MIN_CHARS = 30
// A request for an outcome, not a question. No model call: a classifier on
// every prompt cost seconds (21 s measured under load) for a nudge the model
// can decline itself.
const OUTCOME_VERB = /(고쳐|고치|수정|구현|만들|추가|작성|통과|마이그레이션|리팩터|옮겨|적용|설치|배포|최적화|해결|완성|이전해|바꿔|변환|정리해|\bfix|\bimplement|\badd\b|\bbuild|\bmigrate|\brefactor|\bmake\b.*\bpass|\bport\b|\bdeploy|\bconvert|\bupgrade)/i
const MAX_UNMET_PER_TURN = 5
const MAX_CHECKS = 30
const MAX_PARSE_FAILURES = 2
const TRANSCRIPT_TAIL_CHARS = 40_000
const BLOCK_CHARS = 2_000

const LOOP_MAX_RETRIES = 2
const LOOP_RETRY_DELAY_MS = 120_000
const LOOP_KICKOFF_DELAY_MS = 1_000
const LOOP_OWNER_FRESH_MS = 10 * 60_000
const LOOP_CHECK_TIMEOUT_MS = 600_000
const LOOP_MIN_CHECKS_TO_DEFER = 2
const LOOP_LOG_MAX_LINES = 2_000
const LOOP_EXCLUDES = ['worktrees/', '.claude/goals.md', '.claude/goal-loop.log', '.claude/goal-loop.deny']

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const goalAtom = atom({ plugin: 'goal-mode', key: 'goal' } as const, null, {
  shape: 'goal-2',
})
const metaAtom = atom(
  { plugin: 'goal-mode', key: 'meta' } as const,
  { nativeSeen: false },
  { shape: 'meta-2' },
)

const POLICY = `# Goal mode (goal-mode plugin)

You can set a completion goal for this session with the ${TOOL_ID} tool. Once set, a separate evaluator checks the goal every time you try to stop, and blocks the stop until the goal is met. Only the user can clear it (/${COMMAND} clear).

If the ${NATIVE_TOOL} tool is in your tool list, use it instead, with ask_user false, and do not call ${TOOL_ID}.

Set a goal on your own, without asking, when ALL of these hold:
- The user asked for an outcome with a verifiable end state ("make the tests pass", "migrate every call site", "fix the build").
- The work will plausibly span multiple turns or many tool calls.
- The condition follows directly from the user's request. Never widen scope; never add goals the user did not ask for.
- You are not in plan mode.
Do not set goals for questions, explanations, one-off edits, or reviews. Set at most one goal; never re-set a goal the user cleared.

When a "goal-mode:" note says a request or an approved plan qualifies, set the goal before you start the work, unless the request clearly has no verifiable end state.

Write the condition as ONE measurable end state with its check, e.g. "\`pytest -q\` exits 0 with no failures". The evaluator cannot run commands or read files: it sees only the conversation. So before you stop, re-run the check and leave its real output in the transcript.

After setting a goal, tell the user in one line that you set it and quote the condition.`

const LOOP_POLICY = `# Autonomous goal loop (goal-mode plugin) — ACTIVE

An unattended loop is feeding you goals from the user's queue. Nobody is watching this session.
- Do not ask questions (AskUserQuestion is refused) and do not enter plan mode. Decide with a stated assumption and record it in the commit message.
- A "CONFIDENCE HALT" becomes a call to ${DEFER_TOOL_ID} with the reason, and only for external blockers (credentials, a human decision, missing access) after at least ${LOOP_MIN_CHECKS_TO_DEFER} failed checks. Otherwise keep working.
- Work only inside the goal's worktree; commit after each meaningful step. Push only your goal/* branch, never main or with force.
- Do not call ${TOOL_ID}: the loop sets goals itself.`

const SET_GOAL_DESCRIPTION = `Set this session's completion goal. After it is set, every attempt to stop is checked by an independent evaluator and blocked until the condition is met; only the user can clear it. Use only when the user asked for an outcome with a verifiable end state that spans multiple turns, and never to widen scope. If the ${NATIVE_TOOL} tool is available, use that instead.`

const SET_GOAL_SCHEMA = {
  type: 'object',
  properties: {
    condition: {
      type: 'string',
      description: `One measurable end state, at most ${MAX_CONDITION_CHARS} characters, e.g. "\`bun test\` exits 0".`,
    },
    check: {
      type: 'string',
      description:
        'Optional: the command or observation that proves the condition, e.g. "pytest -q".',
    },
  },
  required: ['condition'],
}

const DEFER_DESCRIPTION = `Autonomous goal loop only: give up on the current queued goal because of an external blocker (credentials, a human decision, missing access), so the loop marks it blocked and moves on. Allowed only after at least ${LOOP_MIN_CHECKS_TO_DEFER} failed checks; stop right after calling it.`

const DEFER_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: 'The external blocker, in one or two sentences.' },
  },
  required: ['reason'],
}

const EVALUATOR_SYSTEM = `You are a strict, skeptical judge of whether an AI coding agent has met a goal. You receive the goal, the agent's final message, and the tail of its transcript (tool calls and their real outputs).

Rules:
- Only real tool output in the transcript counts as evidence. The agent's own claims ("tests pass", "done") are NOT evidence.
- If the goal names a check (a command, a file state), the latest run of that check in the transcript must show success. An earlier success followed by further edits without a re-run is NOT met.
- If evidence is missing, partial, or ambiguous, the goal is NOT met.
- Judge only the stated goal; do not add requirements.

Reply with exactly one line of JSON and nothing else:
{"met": true|false, "reason": "<one sentence: what evidence shows it is met, or what is still missing>"}`

type Verdict =
  | { kind: 'met'; reason: string }
  | { kind: 'unmet'; reason: string }
  | { kind: 'unparsable'; raw: string }
  | { kind: 'failed'; reason: string }

type StopFields = {
  transcript_path: string
  last_assistant_message?: string
}

type LoopCurrent = {
  condition: string
  check?: string
  worktree: string
  branch: string
  startedAt: number
}

type LoopRecord = {
  on: boolean
  repoRoot: string
  sessionId?: string
  heartbeatAt: number
  seq: number
  retries: number
  current?: LoopCurrent
}

type LogEvent = 'start' | 'unmet' | 'met' | 'retry' | 'blocked' | 'deferred' | 'denied' | 'queue-empty' | 'error'

export const register: Register = (on, options) => {
  const autoGoal = options.autoGoal !== false

  on('session.start', async ($, e, next) => {
    await update($, metaAtom, meta => ({ ...meta, cwd: e.cwd }))
    await $.tool.register({
      name: TOOL,
      description: SET_GOAL_DESCRIPTION,
      inputSchema: SET_GOAL_SCHEMA,
      isDeferred: false,
    })
    await $.tool.register({
      name: DEFER_TOOL,
      description: DEFER_DESCRIPTION,
      inputSchema: DEFER_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: COMMAND,
      description: 'Goal: /goal-mode auto [hint] (Claude picks one for now) | set <condition> [--check <cmd>] | status | clear | loop on|off|resume|status',
    })
    await showStatus($)

    return next(e)
  })

  // Remembers who this session is; on a resumed session that owned a loop,
  // picks the loop goal back up.
  on('classic.SessionStart', async ($, e, next) => {
    const below = await next(e)
    await update($, metaAtom, meta => ({ ...meta, sessionId: e.session_id, cwd: e.cwd }))
    const root = await repoRootOf($, e.cwd)
    if (root === undefined) return below
    const rec = await readLoop($, root)
    if (rec === undefined || !rec.on || rec.current === undefined) return below

    if (e.source === 'resume' && rec.sessionId === e.session_id) {
      await resumeLoop($, rec, 'resumed session')
    } else if (Date.now() - rec.heartbeatAt > LOOP_OWNER_FRESH_MS) {
      $.ui.toast(`goal-mode: a loop is on in this repo but idle. /${COMMAND} loop resume to continue it here.`)
    }

    return below
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const meta = await read($, metaAtom)

    return {
      ...composed,
      sections: [
        ...composed.sections,
        { id: 'goal-mode:policy', text: POLICY, scope: 'session' as const },
        ...(meta.loop !== undefined
          ? [{ id: 'goal-mode:loop', text: LOOP_POLICY, scope: 'session' as const }]
          : []),
      ],
    }
  })

  // The native tool is rendered only where the feature is on: seeing it means
  // the model should propose through it, so this plugin's evaluator stays off.
  on('tool.describe', { tool: NATIVE_TOOL }, async ($, e, next) => {
    await update($, metaAtom, meta => ({ ...meta, nativeSeen: true }))

    return next(e)
  })

  on('tool.call', { tool: TOOL_ID }, async ($, e) => {
    const input = e as unknown as { condition?: unknown; check?: unknown }
    const condition =
      typeof input.condition === 'string' ? input.condition.trim() : ''
    const check =
      typeof input.check === 'string' && input.check.trim() !== ''
        ? input.check.trim()
        : undefined
    const meta = await read($, metaAtom)
    const current = await read($, goalAtom)
    // The person's /goal-mode set may name a direction ("pick our next goal")
    // rather than an end state: Claude turns it into one, once.
    const refining = current !== null && current.source === 'user' && current.intent === undefined

    // A goal the person set here is refined here, native tool or not.
    if (meta.nativeSeen && !refining) {
      return {
        deny: `${NATIVE_TOOL} is available in this session: use it with ask_user false instead of ${TOOL_ID}.`,
      }
    }
    if (meta.loop !== undefined) {
      return { deny: 'An autonomous loop is running: it sets goals itself from the queue.' }
    }
    if (meta.lastMode === 'plan') {
      return {
        deny: 'Plan mode is active, so a goal cannot be set yet. Keep planning; set the goal after the plan is approved.',
      }
    }
    if (current !== null && !refining) {
      return {
        deny:
          current.source === 'user' && current.intent !== undefined
            ? `The person's goal was already refined once into "${current.condition}". Only the user can change it now (/${COMMAND} set or clear).`
            : `A goal is already set: "${current.condition}". Only the user can clear it (/${COMMAND} clear).`,
      }
    }
    if (condition === '') {
      return { deny: 'condition is required: one measurable end state.' }
    }
    if (condition.length > MAX_CONDITION_CHARS) {
      return {
        deny: `condition is limited to ${MAX_CONDITION_CHARS} characters; state one end state and its check.`,
      }
    }

    if (refining) {
      const intent = current.condition
      await update($, goalAtom, () => ({ ...newGoal(condition, check, 'user', Date.now()), intent }))
      $.ui.toast(`Goal refined: ${clip(condition, 80)}`)
      await showStatus($)

      return {
        result: `The person's goal "${clip(intent, 120)}" is now: ${condition}${check ? ` (check: ${check})` : ''}. This was the one refinement; the evaluator checks it against their words too. Tell the user the refined goal in one line.`,
      }
    }

    await update($, goalAtom, () => newGoal(condition, check, 'model', Date.now()))
    $.ui.toast(`Goal set: ${clip(condition, 80)}`)
    await showStatus($)

    return {
      result: `Goal set: ${condition}${check ? ` (check: ${check})` : ''}. Stops are now checked by an evaluator until it is met. Tell the user you set it.`,
    }
  })

  // Records the deferral only; the next Stop marks the goal and moves on, so a
  // new goal is never judged against this turn's transcript.
  on('tool.call', { tool: DEFER_TOOL_ID }, async ($, e) => {
    const reason =
      typeof (e as unknown as { reason?: unknown }).reason === 'string'
        ? (e as unknown as { reason: string }).reason.trim()
        : ''
    const meta = await read($, metaAtom)
    const goal = await read($, goalAtom)

    if (meta.loop === undefined || goal === null || goal.source !== 'queue') {
      return { deny: `${DEFER_TOOL_ID} is only for goals of a running autonomous loop.` }
    }
    if (goal.checks < LOOP_MIN_CHECKS_TO_DEFER) {
      return {
        deny: `Too early to defer: only ${goal.checks} failed check(s). Keep working; defer only an external blocker after ${LOOP_MIN_CHECKS_TO_DEFER} failed checks.`,
      }
    }
    if (reason === '') return { deny: 'reason is required.' }
    await update($, goalAtom, g => (g === null ? null : { ...g, deferPending: reason }))

    return { result: 'Deferral recorded. Stop now; the loop marks this goal blocked and moves to the next one.' }
  })

  // Loop-mode guards: no questions, no plan mode, no edits outside the
  // worktree, no dangerous shell. Inactive unless this session runs a loop.
  on('tool.call', async ($, e, next) => {
    const meta = await read($, metaAtom)
    const loop = meta.loop
    if (loop === undefined) return next(e)

    const refusal = guardRefusal(e as unknown as Record<string, unknown>, loop)
    if (refusal === undefined) return next(e)
    await appendLog($, loop.repoRoot, { event: 'denied', tool: e.tool, reason: refusal })

    return { deny: refusal }
  })

  // Only a prompt a person typed resets the per-turn cap; a stop the evaluator
  // blocked continues the same turn and raises no UserPromptSubmit.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    await rememberMode($, e.permission_mode)
    if (e.agent_id === undefined) {
      await update($, goalAtom, goal => (goal === null ? null : resetTurn(goal)))
      await showStatus($)
    }
    const below = await next(e)
    if (!autoGoal || e.agent_id !== undefined || e.permission_mode === 'plan') return below
    const note = await autoGoalNote($, e.prompt)
    if (note === undefined) return below

    return { ...below, additionalContext: [...(below.additionalContext ?? []), note] }
  })

  // The mode is otherwise read only at prompts and stops, so a plan approved
  // mid-turn left set_goal refusing "plan mode" for the rest of that turn.
  // Leaving plan mode is also the surest sign of multi-turn work: say so.
  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await update($, metaAtom, meta => ({ ...meta, lastMode: 'default' }))
    if (!autoGoal) return ran
    const note = await goalNote($, 'The plan was just approved, so this is multi-turn work.')
    if (note === undefined) return ran

    return { ...ran, context: [...(ran.context ?? []), note] }
  })

  on('tool.call', { tool: 'EnterPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await update($, metaAtom, meta => ({ ...meta, lastMode: 'plan' }))

    return ran
  })

  on('classic.Stop', async ($, e, next) => {
    await rememberMode($, e.permission_mode)
    const below = await next(e)
    const goal = await read($, goalAtom)

    if (
      e.agent_id !== undefined ||
      below.block !== undefined ||
      below.preventContinuation === true ||
      goal === null ||
      goal.status !== 'active'
    ) {
      return below
    }

    if (goal.source === 'queue') {
      return loopStop($, goal, e, below)
    }

    const verdict = await evaluate($, goal, e)

    if (verdict.kind === 'met') {
      await update($, goalAtom, () => null)
      $.ui.toast(`Goal met: ${clip(verdict.reason, 100)}`)
      await showStatus($)

      return below
    }
    if (verdict.kind === 'failed') {
      return pause($, below, `the goal check could not complete (${verdict.reason})`)
    }
    if (verdict.kind === 'unparsable') {
      const failures = goal.parseFailures + 1
      if (failures >= MAX_PARSE_FAILURES) {
        return pause($, below, 'the goal check gave no readable verdict')
      }
      await update($, goalAtom, g => (g === null ? null : { ...g, parseFailures: failures }))

      return below
    }

    const counted = await countUnmet($, verdict.reason)
    if (counted.checks >= MAX_CHECKS) {
      return pause($, below, `the goal stayed unmet after ${counted.checks} checks`)
    }
    if (counted.unmetThisTurn >= MAX_UNMET_PER_TURN) {
      return pause($, below, 'goal checks kept finding it unmet this turn')
    }
    await showStatus($)

    return { ...below, block: blockText(verdict.reason, goal) }
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim().split(/\s+/).filter(word => word !== '')

    if (args[0] === 'loop') {
      return { text: await loopCommand($, args[1] ?? 'status') }
    }

    // `auto`, or `set` with nothing after it: Claude picks the goal itself.
    if (args[0] === 'auto' || (args[0] === 'set' && args.length === 1)) {
      return { text: await autoCommand($, args[0] === 'auto' ? e.args.trim().slice('auto'.length).trim() : '') }
    }
    if (args[0] === 'set') {
      return { text: await setCommand($, e.args.trim().slice('set'.length)) }
    }

    const goal = await read($, goalAtom)
    if (args[0] === 'clear') {
      await update($, goalAtom, () => null)
      await showStatus($)

      return { text: goal === null ? 'No goal set.' : `Goal cleared: ${goal.condition}` }
    }
    if (goal === null) {
      return { text: 'No goal set. Claude sets one itself when a task has a verifiable end state.' }
    }

    return {
      text: [
        `Goal ${goal.status}${goal.source === 'user' ? (goal.intent !== undefined ? ' (yours, refined by Claude)' : ' (set by you)') : ''}: ${goal.condition}`,
        goal.intent !== undefined ? `Your words: ${goal.intent}` : undefined,
        goal.check ? `Check: ${goal.check}` : undefined,
        `Checks: ${goal.checks} (this turn ${goal.unmetThisTurn})`,
        goal.lastReason ? `Last check: ${goal.lastReason}` : 'Last check: not yet evaluated',
        goal.pausedBecause ? `Paused: ${goal.pausedBecause}. Send a message to continue.` : undefined,
        `/${COMMAND} clear to stop early`,
      ]
        .filter(line => line !== undefined)
        .join('\n'),
    }
  })
}

// `<condition> [--check <command>]`, the text after `/goal-mode set`.
export function parseSetArgs(text: string): { condition: string; check?: string } {
  const at = text.search(/(^|\s)--check(\s|$)/)
  if (at < 0) return { condition: text.trim() }
  const condition = text.slice(0, at).trim()
  const check = text.slice(at).replace(/^\s*--check/, '').trim()
  return { condition, check: check === '' ? undefined : check }
}

// The person sets the goal themself: the same evaluator, no model judgement
// on whether to set it, and the work starts at once.
// The person hands the choice of goal to Claude: no goal is stored here; the
// kickoff asks Claude to read the situation, pick one measurable end state and
// set it with set_goal (an empty slot, so the tool takes it), then start.
async function autoCommand($: EngineInterface, hint: string): Promise<string> {
  const meta = await read($, metaAtom)
  if (meta.loop !== undefined) return `An autonomous loop is running and sets goals from its queue: /${COMMAND} loop off first.`
  if (meta.lastMode === 'plan') return 'Plan mode is active: approve the plan first; the approval itself prompts Claude to set a goal.'
  const previous = await read($, goalAtom)
  if (previous !== null) await update($, goalAtom, () => null)
  await showStatus($)
  const how = meta.nativeSeen ? `${NATIVE_TOOL} with ask_user false` : TOOL_ID
  const kickoff = [
    `[goal-mode] The person ran /${COMMAND} auto: choose this session's goal yourself, to fit the situation as it stands now.`,
    hint !== '' ? `Their hint: ${hint}` : undefined,
    previous !== null ? `The goal before it (now cleared): ${previous.condition}${previous.lastReason ? ` — last check: ${previous.lastReason}` : ''}` : undefined,
    'Read the situation first: this conversation, any approved plan, the repository state (git status, branch, open PR), and work left unfinished or blocked.',
    'Pick the one next outcome that matters most and can be finished in this session, stated as one measurable end state with the check that proves it. Stay within the work this session is already about; do not widen scope.',
    `Decide it yourself, without asking the person to choose; ask only if every candidate needs their call (credentials, payment, an irreversible step). Then call ${how}, tell the person the goal in one line, and start on it.`,
  ]
    .filter(line => line !== undefined)
    .join('\n')
  $.clock.after(50, () => {
    $.prompt.submit({ text: kickoff }).catch(() => $.ui.toast('goal-mode: the kickoff prompt was not submitted; send any message to start.'))
  })

  return previous === null
    ? 'Claude picks a goal for the current situation now and sets it.'
    : `Cleared "${clip(previous.condition, 60)}"; Claude picks a new goal for the current situation now.`
}

async function setCommand($: EngineInterface, text: string): Promise<string> {
  const { condition, check } = parseSetArgs(text)
  const meta = await read($, metaAtom)
  if (condition === '') return `Usage: /${COMMAND} set <one measurable end state> [--check <command that proves it>]`
  if (condition.length > MAX_CONDITION_CHARS) return `The condition is limited to ${MAX_CONDITION_CHARS} characters; state one end state.`
  if (meta.loop !== undefined) return `An autonomous loop is running and sets goals from its queue: /${COMMAND} loop off first.`
  if (meta.lastMode === 'plan') return 'Plan mode is active: every stop would be blocked while nothing can be done. Set the goal after the plan is approved.'
  const previous = await read($, goalAtom)
  await update($, goalAtom, () => newGoal(condition, check, 'user', Date.now()))
  await showStatus($)
  // A prompt from a command.run hook would wait on this very command: a timer
  // submits it once the hook has returned.
  const kickoff =
    `[goal-mode] The person set this session's goal with /${COMMAND} set: "${condition}"${check ? ` (check: ${check})` : ''}. ` +
    'If it names a direction rather than one measurable end state (e.g. "pick our next goal"), first turn it into one, asking the person if the choice is theirs, and call mcp__goal-mode__set_goal once to refine it; ' +
    'otherwise work toward it now. Every stop is checked by an independent evaluator until it is met, so before stopping re-run the check and leave its real output in the transcript.'
  $.clock.after(50, () => {
    $.prompt.submit({ text: kickoff }).catch(() => $.ui.toast('goal-mode: the goal is set, but the kickoff prompt was not submitted; send any message to start.'))
  })

  return [
    previous === null ? `Goal set: ${condition}` : `Goal replaced: ${condition}\n(was: ${previous.condition})`,
    check ? `Check: ${check}` : undefined,
    `Claude starts on it now; /${COMMAND} clear to stop.`,
  ]
    .filter(line => line !== undefined)
    .join('\n')
}

// ---------------------------------------------------------------- loop mode

async function loopCommand($: EngineInterface, action: string): Promise<string> {
  const meta = await read($, metaAtom)
  const root = await repoRootOf($, meta.cwd)
  if (root === undefined) return 'Not inside a git repository: the loop needs one.'
  const rec = await readLoop($, root)

  if (action === 'status') return loopStatus($, root, rec)

  if (action === 'off') {
    if (rec === undefined || !rec.on) return 'The loop is not on.'
    await writeLoop($, { ...rec, on: false })

    return rec.current === undefined
      ? 'Loop off.'
      : `Loop off: the current goal "${clip(rec.current.condition, 60)}" keeps running; no further goals are taken.`
  }

  if (action !== 'on' && action !== 'resume') {
    return `Usage: /${COMMAND} loop on|off|resume|status`
  }

  const fresh = rec !== undefined && Date.now() - rec.heartbeatAt < LOOP_OWNER_FRESH_MS
  if (rec?.on === true && rec.sessionId !== meta.sessionId && fresh) {
    return 'Another session runs this loop and was active in the last 10 minutes; stop it there first.'
  }
  const goal = await read($, goalAtom)
  if (goal !== null && goal.source !== 'queue') {
    return `A session goal is active ("${clip(goal.condition, 60)}"): /${COMMAND} clear it before starting the loop.`
  }

  await ensureExcludes($, root)
  let queueText: string
  try {
    queueText = await $.fs.read(queuePath(root))
  } catch {
    return `No queue: write goals to ${queuePath(root)}, one per line, e.g.\n- [ ] make add() return a + b :: check: pytest -q`
  }

  const owned: LoopRecord = {
    on: true,
    repoRoot: root,
    sessionId: meta.sessionId,
    heartbeatAt: Date.now(),
    seq: rec?.seq ?? 0,
    retries: rec?.retries ?? 0,
    current: rec?.current,
  }
  await writeLoop($, owned)

  if (owned.current !== undefined) {
    await resumeLoop($, owned, action === 'resume' ? 'resumed by the user' : 'loop turned on')

    return `Loop on: continuing goal "${clip(owned.current.condition, 60)}" in ${owned.current.worktree}.`
  }
  const pending = summarize(parseQueue(queueText)).pending
  const started = await startNext($, owned)

  return started === undefined
    ? `Loop on, but the queue has no pending goals (${pending}).`
    : `Loop on: ${pending} pending goal(s); started "${clip(started.condition, 60)}" in ${started.worktree}.`
}

async function loopStatus($: EngineInterface, root: string, rec: LoopRecord | undefined): Promise<string> {
  let counts = 'no queue file'
  try {
    const s = summarize(parseQueue(await $.fs.read(queuePath(root))))
    counts = `${s.done} done, ${s.blocked} blocked, ${s.pending} pending of ${s.total}`
  } catch {
    // No queue yet.
  }
  let tail: string[] = []
  try {
    tail = (await $.fs.read(logPath(root))).trim().split('\n').slice(-5)
  } catch {
    // No log yet.
  }

  return [
    `Loop ${rec?.on === true ? 'on' : 'off'} · queue: ${counts}`,
    rec?.current ? `Current: ${rec.current.condition}\nWorktree: ${rec.current.worktree} (${rec.current.branch}) · retries ${rec.retries}/${LOOP_MAX_RETRIES}` : 'Current: none',
    tail.length > 0 ? `Recent log:\n${tail.join('\n')}` : undefined,
  ]
    .filter(line => line !== undefined)
    .join('\n')
}

// Takes the next pending queue line, makes its worktree, sets the goal and
// sends the kickoff. Returns undefined when the queue is empty (loop turns off).
async function startNext($: EngineInterface, rec: LoopRecord): Promise<LoopCurrent | undefined> {
  const root = rec.repoRoot
  for (let attempt = 0; attempt < 5; attempt++) {
    let text: string
    try {
      text = await $.fs.read(queuePath(root))
    } catch {
      text = ''
    }
    const item = nextPending(parseQueue(text))
    if (item === undefined) {
      await writeLoop($, { ...rec, on: false, current: undefined, retries: 0 })
      await setLoopView($, undefined)
      await update($, goalAtom, () => null)
      await appendLog($, root, { event: 'queue-empty' })
      await notify($, 'Goal loop: queue finished.')
      await showStatus($)

      return undefined
    }

    const seq = rec.seq + 1
    const name = `${String(seq).padStart(2, '0')}-${slugify(item.condition)}`
    const worktree = `${root}/worktrees/goal-${name}`
    const branch = `goal/${name}`
    rec = { ...rec, seq }

    const made = await run($, ['git', '-C', root, 'worktree', 'add', worktree, '-b', branch], root, 60_000)
    if (made.exitCode !== 0) {
      const why = clip(made.stderr.trim() || made.stdout.trim() || 'git worktree add failed', 300)
      await markQueue($, root, item.condition, '!', `blocked ${isoNow()}: could not create worktree: ${why}`)
      await appendLog($, root, { event: 'error', goal: item.condition, reason: why })
      await writeLoop($, rec)
      continue
    }

    const current: LoopCurrent = {
      condition: item.condition,
      check: item.check,
      worktree,
      branch,
      startedAt: Date.now(),
    }
    rec = { ...rec, current, retries: 0, heartbeatAt: Date.now() }
    await writeLoop($, rec)
    await setLoopView($, { repoRoot: root, worktree, branch, extraDeny: await readDenyFile($, root) })
    await update($, goalAtom, () => newGoal(item.condition, item.check, 'queue', Date.now()))
    await appendLog($, root, { event: 'start', goal: item.condition, worktree, branch })
    await showStatus($)
    submitLater($, root, kickoffText(current, seq), LOOP_KICKOFF_DELAY_MS)

    return current
  }

  await writeLoop($, { ...rec, on: false })
  await notify($, 'Goal loop stopped: could not start any goal (worktree errors).')

  return undefined
}

async function resumeLoop($: EngineInterface, rec: LoopRecord, why: string): Promise<void> {
  const current = rec.current
  if (current === undefined) return
  const owned = { ...rec, sessionId: (await read($, metaAtom)).sessionId, heartbeatAt: Date.now() }
  await writeLoop($, owned)
  await setLoopView($, {
    repoRoot: rec.repoRoot,
    worktree: current.worktree,
    branch: current.branch,
    extraDeny: await readDenyFile($, rec.repoRoot),
  })
  const goal = await read($, goalAtom)
  if (goal === null || goal.source !== 'queue' || goal.condition !== current.condition) {
    await update($, goalAtom, () => newGoal(current.condition, current.check, 'queue', current.startedAt))
  } else {
    await update($, goalAtom, g => (g === null ? null : resetTurn(g)))
  }
  await appendLog($, rec.repoRoot, { event: 'start', goal: current.condition, reason: why })
  await showStatus($)
  submitLater(
    $,
    rec.repoRoot,
    `[goal-mode loop] Continuing (${why}).\n\n${kickoffText(current, owned.seq)}`,
    LOOP_KICKOFF_DELAY_MS,
  )
}

// A prompt submitted from inside a hook that holds the turn (command.run,
// classic.Stop) is refused by the engine: it would wait on that very turn. A
// timer fires after the hook returned, and the prompt then starts a turn of
// its own once the session is idle.
function submitLater($: EngineInterface, root: string, text: string, delayMs: number): void {
  $.clock.after(delayMs, () => {
    $.prompt.submit({ text }).catch(async error => {
      await appendLog($, root, { event: 'error', reason: `prompt not submitted: ${clip(String(error), 300)}` })
      await notify($, 'Goal loop stalled: a prompt could not be submitted. /goal-mode loop resume to retry.')
    })
  })
}

async function loopStop<R extends { block?: string }>(
  $: EngineInterface,
  goal: Goal,
  e: StopFields,
  below: R,
): Promise<R> {
  const meta = await read($, metaAtom)
  const loop = meta.loop
  const root = loop?.repoRoot ?? (await repoRootOf($, meta.cwd))
  if (root === undefined) return below
  const rec = await readLoop($, root)
  if (rec === undefined || rec.current === undefined || loop === undefined) {
    // The loop record is gone (turned off elsewhere): drop the orphan goal.
    await update($, goalAtom, () => null)
    await setLoopView($, undefined)
    await showStatus($)

    return below
  }
  await writeLoop($, { ...rec, heartbeatAt: Date.now() })

  if (goal.deferPending !== undefined) {
    await finishGoal($, rec, '!', `deferred ${isoNow()}: ${goal.deferPending}`, 'deferred', goal.deferPending)

    return below
  }

  // 1. The queue's own check, run deterministically in the worktree.
  let evidence: string | undefined
  if (goal.check !== undefined) {
    let ran: ProcessResult
    try {
      ran = await run($, ['bash', '-lc', goal.check], loop.worktree, LOOP_CHECK_TIMEOUT_MS)
    } catch (error) {
      return loopStuck($, rec, goal, below, `the check could not run (${clip(String(error), 200)})`)
    }
    const output = clip(`${ran.stdout}\n${ran.stderr}`.trim(), 1_500, true)
    if (ran.exitCode !== 0) {
      return loopUnmet($, rec, goal, below, `check \`${goal.check}\` exited ${ran.exitCode}:\n${output}`)
    }
    evidence = `The loop ran the check \`${goal.check}\` in ${loop.worktree}: exit 0.\n${output}`
  }

  // 2. Every step must be committed before the goal can count as met.
  const status = await run($, ['git', '-C', loop.worktree, 'status', '--porcelain'], loop.worktree, 60_000).catch(
    () => undefined,
  )
  const pending = status === undefined ? [] : uncommitted(status.stdout)
  if (pending.length > 0) {
    return loopUnmet($, rec, goal, below, `uncommitted changes in ${loop.worktree}; commit them:\n${clip(pending.join('\n'), 600)}`)
  }

  // 3. The independent judge, given the check's result as evidence.
  const verdict = await evaluate($, goal, e, evidence)
  if (verdict.kind === 'met') {
    await finishGoal($, rec, 'x', `done ${isoNow()} ${loop.branch}, ${goal.checks} failed checks`, 'met', verdict.reason)

    return below
  }
  if (verdict.kind === 'unmet') return loopUnmet($, rec, goal, below, verdict.reason)
  if (verdict.kind === 'failed') return loopStuck($, rec, goal, below, `the goal check could not complete (${verdict.reason})`)

  const failures = goal.parseFailures + 1
  if (failures >= MAX_PARSE_FAILURES) return loopStuck($, rec, goal, below, 'the goal check gave no readable verdict')
  await update($, goalAtom, g => (g === null ? null : { ...g, parseFailures: failures }))

  return below
}

async function loopUnmet<R extends { block?: string }>(
  $: EngineInterface,
  rec: LoopRecord,
  goal: Goal,
  below: R,
  reason: string,
): Promise<R> {
  const counted = await countUnmet($, reason)
  await appendLog($, rec.repoRoot, { event: 'unmet', goal: goal.condition, reason: clip(reason, 300), checks: counted.checks })
  if (counted.checks >= MAX_CHECKS) {
    await finishGoal($, rec, '!', `blocked ${isoNow()}: unmet after ${counted.checks} checks: ${clip(reason, 200)}`, 'blocked', reason)

    return below
  }
  if (counted.unmetThisTurn >= MAX_UNMET_PER_TURN) {
    return loopStuck($, rec, goal, below, 'goal checks kept finding it unmet this turn')
  }
  await showStatus($)

  return { ...below, block: blockText(reason, goal) }
}

// Stuck: retry with a change of approach after a pause, then give up on the
// goal and move on. The stop itself is allowed either way.
async function loopStuck<R>($: EngineInterface, rec: LoopRecord, goal: Goal, below: R, because: string): Promise<R> {
  if (rec.retries >= LOOP_MAX_RETRIES || rec.current === undefined) {
    const last = goal.lastReason ?? because
    await finishGoal($, rec, '!', `blocked ${isoNow()}: ${clip(last, 200)}`, 'blocked', last)

    return below
  }
  const retries = rec.retries + 1
  await writeLoop($, { ...rec, retries })
  await update($, goalAtom, g => (g === null ? null : resetTurn(g)))
  await appendLog($, rec.repoRoot, { event: 'retry', goal: goal.condition, reason: because, retries })
  await showStatus($)
  const current = rec.current
  const reasons = (await read($, goalAtom))?.recentReasons ?? []
  submitLater($, rec.repoRoot, retryText(current, retries, reasons), LOOP_RETRY_DELAY_MS)

  return below
}

// Marks the queue line, logs, notifies and, while the loop is on, starts the
// next goal. The worktree and branch stay for review.
async function finishGoal(
  $: EngineInterface,
  rec: LoopRecord,
  mark: 'x' | '!',
  note: string,
  event: LogEvent,
  reason: string,
): Promise<void> {
  const current = rec.current
  if (current === undefined) return
  await markQueue($, rec.repoRoot, current.condition, mark, note)
  await appendLog($, rec.repoRoot, { event, goal: current.condition, reason: clip(reason, 300), branch: current.branch })
  await notify($, `Goal ${mark === 'x' ? 'met' : event}: ${clip(current.condition, 80)}`)
  await update($, goalAtom, () => null)
  await setLoopView($, undefined)
  const after: LoopRecord = { ...rec, current: undefined, retries: 0, heartbeatAt: Date.now() }
  await writeLoop($, after)
  await showStatus($)
  if (after.on) await startNext($, after)
}

function guardRefusal(e: Record<string, unknown>, loop: LoopView): string | undefined {
  const tool = String(e.tool)
  if (tool === 'AskUserQuestion') {
    return `Autonomous loop: nobody can answer. Decide with a stated assumption, or call ${DEFER_TOOL_ID} for an external blocker.`
  }
  if (tool === 'EnterPlanMode') return 'Autonomous loop: plan mode would stop the loop; plan inline and keep working.'
  if (tool === 'Bash' && typeof e.command === 'string') return checkBash(e.command, loop)
  if ((tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') && typeof e.file_path === 'string') {
    return checkPath(e.file_path, loop)
  }
  if (tool === 'NotebookEdit' && typeof e.notebook_path === 'string') return checkPath(e.notebook_path, loop)

  return undefined
}

function kickoffText(current: LoopCurrent, seq: number): string {
  return [
    `[goal-mode loop] Goal #${seq}: ${current.condition}`,
    current.check
      ? `Check (the loop runs it in the worktree at every stop; it must exit 0): ${current.check}`
      : 'No check command: an independent evaluator judges the goal from the transcript, so leave real evidence.',
    `Work ONLY in the git worktree ${current.worktree} (branch ${current.branch}); cd there first. Edits elsewhere in the repository are refused.`,
    'Commit after each meaningful step: the goal is not accepted with uncommitted changes.',
    `You may push only this branch (git push -u origin ${current.branch}); never main/master, never with force.`,
    `Nobody is watching: do not ask questions. Decide with a stated assumption and record it in the commit message. For an external blocker (credentials, a human decision, missing access), call ${DEFER_TOOL_ID} after at least ${LOOP_MIN_CHECKS_TO_DEFER} failed checks.`,
  ].join('\n')
}

function retryText(current: LoopCurrent, retries: number, reasons: readonly string[]): string {
  return [
    `[goal-mode loop] Retry ${retries}/${LOOP_MAX_RETRIES} for: ${current.condition}`,
    'The last checks found it unmet:',
    ...reasons.map(reason => `- ${clip(reason, 400)}`),
    `Step back: list the approaches you have tried and why they failed, then pick a materially different approach (a subagent may investigate). Continue in ${current.worktree} on ${current.branch}.`,
  ].join('\n')
}

type ProcessResult = { exitCode: number; stdout: string; stderr: string }

async function run($: EngineInterface, argv: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  const result = await $.process.run(argv, { cwd, timeoutMs })

  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
}

// The main checkout's root, also when called from inside a worktree.
async function repoRootOf($: EngineInterface, cwd: string | undefined): Promise<string | undefined> {
  if (cwd === undefined) return undefined
  try {
    const ran = await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd, 15_000)
    if (ran.exitCode !== 0) return undefined
    const common = ran.stdout.trim()

    return common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : undefined
  } catch {
    return undefined
  }
}

const loopKey = (root: string) => `loop:${root}`
const queuePath = (root: string) => `${root}/.claude/goals.md`
const logPath = (root: string) => `${root}/.claude/goal-loop.log`
const denyPath = (root: string) => `${root}/.claude/goal-loop.deny`

async function readLoop($: EngineInterface, root: string): Promise<LoopRecord | undefined> {
  const value = await $.store.get(loopKey(root))

  return typeof value === 'object' && value !== null ? (value as LoopRecord) : undefined
}

async function writeLoop($: EngineInterface, rec: LoopRecord): Promise<void> {
  await $.store.set(loopKey(rec.repoRoot), rec)
}

async function setLoopView($: EngineInterface, loop: LoopView | undefined): Promise<void> {
  await update($, metaAtom, meta => ({ ...meta, loop }))
}

async function markQueue($: EngineInterface, root: string, condition: string, mark: 'x' | '!', note: string): Promise<void> {
  try {
    const text = await $.fs.read(queuePath(root))
    await $.fs.write(queuePath(root), markItem(text, condition, mark, note))
  } catch {
    // The queue file vanished; the log still records the outcome.
  }
}

async function readDenyFile($: EngineInterface, root: string): Promise<string[]> {
  try {
    return (await $.fs.read(denyPath(root)))
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
  } catch {
    return []
  }
}

async function ensureExcludes($: EngineInterface, root: string): Promise<void> {
  const path = `${root}/.git/info/exclude`
  let text = ''
  try {
    text = await $.fs.read(path)
  } catch {
    // No exclude file yet.
  }
  const have = new Set(text.split('\n').map(line => line.trim()))
  const missing = LOOP_EXCLUDES.filter(line => !have.has(line))
  if (missing.length === 0) return
  const head = text === '' || text.endsWith('\n') ? text : `${text}\n`
  await $.fs.write(path, `${head}# goal-mode loop\n${missing.join('\n')}\n`)
}

async function appendLog($: EngineInterface, root: string, entry: Record<string, unknown>): Promise<void> {
  try {
    let text = ''
    try {
      text = await $.fs.read(logPath(root))
    } catch {
      // First entry.
    }
    const lines = text.split('\n').filter(line => line !== '')
    lines.push(JSON.stringify({ ts: isoNow(), ...entry }))
    await $.fs.write(logPath(root), `${lines.slice(-LOOP_LOG_MAX_LINES).join('\n')}\n`)
  } catch {
    // Logging never stops the loop.
  }
}

async function notify($: EngineInterface, text: string): Promise<void> {
  $.ui.toast(text)
  try {
    await $.ui.notify(text, { title: 'goal-mode' })
  } catch {
    // No notification channel (headless); the toast and the log remain.
  }
}

// ------------------------------------------------------------- evaluation

async function evaluate($: EngineInterface, goal: Goal, e: StopFields, evidence?: string): Promise<Verdict> {
  const ask = [
    `Goal: ${goal.condition}`,
    // A refined goal still answers to the person's words: a refinement that
    // dodged them is not met.
    goal.intent !== undefined ? `The person asked for: ${goal.intent} (the goal above is Claude's measurable form of it; judge the goal, and call it unmet if it plainly fails that request).` : undefined,
    goal.check ? `Check: ${goal.check}` : undefined,
    evidence ? `\nVerified by the harness (trustworthy):\n${evidence}` : undefined,
    '',
    "The agent's final message:",
    e.last_assistant_message ?? '(none)',
  ]
    .filter(line => line !== undefined)
    .join('\n')

  let tail: string | undefined
  try {
    tail = transcriptTail(await $.fs.read(e.transcript_path))
  } catch {
    tail = undefined
  }

  // A transcript past the read cap is judged by a fork over the session's own
  // context: same model, so less independent, but it sees everything.
  // A request the engine refuses to send (a blocked model) rejects; it must
  // pause the goal, not throw and leave every later Stop silently skipped.
  let reply: ModelForkResult
  try {
    reply =
      tail === undefined
        ? await $.model.fork({
            prompt: `${EVALUATOR_SYSTEM}\n\nThe transcript above is the agent's work. ${ask}`,
          })
        : await $.model.complete({
            model: EVALUATOR_MODEL,
            system: EVALUATOR_SYSTEM,
            prompt: `${ask}\n\nTranscript tail (oldest first):\n${tail}`,
            maxTokens: 300,
            timeoutMs: EVALUATOR_TIMEOUT_MS,
          })
  } catch (error) {
    return { kind: 'failed', reason: clip(String(error), 200) }
  }

  if (!reply.isAnswered) {
    return { kind: 'failed', reason: reply.reason }
  }

  return parseVerdict(reply.text)
}

export function parseVerdict(text: string): Verdict {
  const match = text.match(/\{[\s\S]*\}/)
  if (match === null) {
    return { kind: 'unparsable', raw: text }
  }
  try {
    const parsed = JSON.parse(match[0]) as { met?: unknown; reason?: unknown }
    const reason = typeof parsed.reason === 'string' ? parsed.reason : 'no reason given'
    if (parsed.met === true) return { kind: 'met', reason }
    if (parsed.met === false) return { kind: 'unmet', reason }

    return { kind: 'unparsable', raw: text }
  } catch {
    return { kind: 'unparsable', raw: text }
  }
}

// Renders the newest transcript rows (text, tool calls, tool results) as plain
// lines, keeping the last TRANSCRIPT_TAIL_CHARS characters.
export function transcriptTail(jsonl: string): string {
  const lines: string[] = []
  for (const raw of jsonl.split('\n')) {
    if (raw.trim() === '') continue
    let row: { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown } }
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    if ((row.type !== 'user' && row.type !== 'assistant') || row.message === undefined) continue
    const role = row.message.role ?? row.type
    const content = row.message.content
    if (typeof content === 'string') {
      lines.push(`[${role}] ${clip(content, 2_000)}`)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        lines.push(`[${role}] ${clip(block.text, 2_000)}`)
      } else if (block.type === 'tool_use') {
        lines.push(`[tool_use ${String(block.name)}] ${clip(JSON.stringify(block.input), 1_000)}`)
      } else if (block.type === 'tool_result') {
        lines.push(`[tool_result${block.is_error === true ? ' error' : ''}] ${clip(resultText(block.content), 2_500)}`)
      }
    }
  }
  const joined = lines.join('\n')

  return joined.length > TRANSCRIPT_TAIL_CHARS ? joined.slice(-TRANSCRIPT_TAIL_CHARS) : joined
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(part =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text)
        : '',
    )
    .join('\n')
}

// ------------------------------------------------------------- goal state

function newGoal(condition: string, check: string | undefined, source: Goal['source'], setAt: number): Goal {
  return {
    condition,
    check,
    source,
    setAt,
    checks: 0,
    unmetThisTurn: 0,
    parseFailures: 0,
    recentReasons: [],
    status: 'active',
  }
}

function resetTurn(goal: Goal): Goal {
  return { ...goal, unmetThisTurn: 0, parseFailures: 0, status: 'active', pausedBecause: undefined }
}

async function countUnmet($: EngineInterface, reason: string): Promise<{ checks: number; unmetThisTurn: number }> {
  const goal = await update($, goalAtom, g =>
    g === null
      ? null
      : {
          ...g,
          checks: g.checks + 1,
          unmetThisTurn: g.unmetThisTurn + 1,
          lastReason: reason,
          recentReasons: [...g.recentReasons, reason].slice(-3),
        },
  )

  return { checks: goal?.checks ?? 0, unmetThisTurn: goal?.unmetThisTurn ?? 0 }
}

function blockText(reason: string, goal: Goal): string {
  return clip(
    `Goal not met: ${reason}\nKeep working toward the goal: ${goal.condition}${goal.check ? `\nCheck: ${goal.check}` : ''}\nRe-run the check before you stop so its output is in the transcript.`,
    BLOCK_CHARS,
  )
}

async function pause<R>($: EngineInterface, below: R, because: string): Promise<R> {
  await update($, goalAtom, g =>
    g === null ? null : { ...g, status: 'paused' as const, pausedBecause: because },
  )
  $.ui.toast(`Goal paused: ${because}. Send a message to continue, or /${COMMAND} clear.`)
  await showStatus($)

  return below
}

// Whether a typed prompt plausibly asks for multi-turn work toward an outcome.
export function autoGoalCandidate(prompt: string): boolean {
  const text = prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim()
  if (text.length < AUTO_GOAL_MIN_CHARS) return false
  if (/<command-name>/.test(text) || text.startsWith('/')) return false
  // A question, not a request for an outcome.
  if (/[?？]\s*$/.test(text) || /(인가요|일까요|나요|습니까|어때|뭐야|왜)\s*[?？]?\s*$/.test(text)) return false

  return OUTCOME_VERB.test(text)
}

async function autoGoalNote($: EngineInterface, prompt: string): Promise<string | undefined> {
  if (!autoGoalCandidate(prompt)) return undefined

  return goalNote($, 'This request looks like work toward an outcome.')
}

// The nudge itself; undefined when no goal can be set now.
async function goalNote($: EngineInterface, why: string): Promise<string | undefined> {
  const goal = await read($, goalAtom)
  const meta = await read($, metaAtom)
  if (goal !== null || meta.loop !== undefined) return undefined
  const how = meta.nativeSeen ? `${NATIVE_TOOL} with ask_user false` : TOOL_ID

  return `goal-mode: ${why} If it has a verifiable end state and will take more than a few tool calls, set the session goal now with ${how}, before starting: one measurable end state from the user's own words, with the check that proves it. Do not widen scope. Otherwise skip this note and say nothing about it.`
}

async function rememberMode($: EngineInterface, mode: string | undefined): Promise<void> {
  if (mode === undefined) return
  const meta: GoalMeta = await read($, metaAtom)
  if (meta.lastMode !== mode) {
    await update($, metaAtom, m => ({ ...m, lastMode: mode }))
  }
}

async function showStatus($: EngineInterface): Promise<void> {
  const goal = await read($, goalAtom)
  const meta = await read($, metaAtom)
  const loop = meta.loop !== undefined ? 'loop·' : ''
  // A running goal is a piece of the status line; a paused one waits on the
  // person, so it also takes a notice row.
  await segment($, goal === null ? (meta.loop !== undefined ? 'loop·idle' : '') : `${loop}goal${goal.status === 'paused' ? '⏸' : ''}·${goal.checks}`)
  $.ui.status(goal !== null && goal.status === 'paused' ? `goal paused: ${clip(goal.condition, 40)}${goal.pausedBecause ? ` (${clip(goal.pausedBecause, 40)})` : ''}` : undefined)
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z')
}

function clip(text: string, max: number, fromEnd = false): string {
  if (text.length <= max) return text

  return fromEnd ? `…${text.slice(-(max - 1))}` : `${text.slice(0, max - 1)}…`
}
