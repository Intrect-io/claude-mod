// auto-claude's pure part for planning: plan validation and the prompts that
// start a run and replan it. The queue grammar is goal-mode's own, generated
// into ./queue.ts from shared/queue.ts.

import { parseQueue } from './queue'
import type { QueueItem } from './queue'

export { parseQueue }
export type { QueueItem }

// `Final check: <command>` in auto-plan.md, backticks optional.
export function finalCheckOf(plan: string): string | undefined {
  const m = plan.match(/^\s*(?:[-*]\s*)?\**final check\**\s*:\s*`?([^`\n]+?)`?\s*$/im)
  return m?.[1]?.trim() || undefined
}

export type PlanVerdict = { ok: true; finalCheck: string; pending: QueueItem[] } | { ok: false; errors: string[] }

export const MIN_MILESTONES = 2

// Words that put shipping into a milestone's end state, which the loop judges
// before anything is pushed (measured: "…, merged to main" stayed unmet).
const SHIPPING = /\b(merged|merge[sd]? (in)?to|pushed|push(ed)? to|pull request|PR (is )?(open|opened|created|merged))\b|머지|병합|푸시/i

// The plan Claude wrote is the contract the run holds it to: a final check,
// and pending milestones that each carry their own runnable check.
export function validatePlan(plan: string | undefined, queue: string | undefined, firstRound: boolean): PlanVerdict {
  const errors: string[] = []
  if (plan === undefined) errors.push('.claude/auto-plan.md is missing.')
  const finalCheck = plan === undefined ? undefined : finalCheckOf(plan)
  if (plan !== undefined && finalCheck === undefined) errors.push('auto-plan.md has no "Final check: `<command>`" line.')
  if (queue === undefined) errors.push('.claude/goals.md is missing.')
  const items = queue === undefined ? [] : parseQueue(queue)
  const pending = items.filter(i => i.mark === ' ')
  const need = firstRound ? MIN_MILESTONES : 1
  if (queue !== undefined && pending.length < need) errors.push(`goals.md needs at least ${need} pending milestone line(s) "- [ ] <end state> :: check: <command>"; it has ${pending.length}.`)
  for (const item of pending) {
    if (SHIPPING.test(item.condition)) errors.push(`a milestone says what is true on its own branch; merging, pushing and PRs happen after it is met: "${item.condition.slice(0, 80)}"`)
    if (item.check === undefined) errors.push(`milestone without a check: "${item.condition.slice(0, 80)}"`)
    if (item.base !== undefined) errors.push(`milestones take no ":: base:" (auto-claude sets the base): "${item.condition.slice(0, 80)}"`)
  }
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.condition)) errors.push(`duplicate milestone: "${item.condition.slice(0, 80)}"`)
    seen.add(item.condition)
  }
  if (errors.length > 0 || finalCheck === undefined) return { ok: false, errors }

  return { ok: true, finalCheck, pending }
}

export const READY_TOOL = 'auto_plan_ready'

export function kickoffText(hint: string, base: string): string {
  return [
    '[auto-claude] The person started an autonomous run of this repository. Plan it now; build nothing yet.',
    hint !== '' ? `Their aim: ${hint}` : 'No aim was given: finish what this repository is evidently for.',
    'Read the situation: README and docs, plan.md / IMPROVEMENTS.md / TODO notes, git log and status, open PRs and issues (Linear too if this repo maps to a project), and failing tests.',
    'Aim at the long-term end state of the whole work, not a first step. Then write two files in the repository root:',
    '1. .claude/auto-plan.md: ## Goal (the end state, with its quality bar), a line `Final check: <one shell command that passes only when the whole goal is met>`, ## Milestones (ordered, why each), ## Decisions (empty for now).',
    `2. .claude/goals.md: one line per milestone, in order: \`- [ ] <milestone end state> :: check: <shell command that proves it>\`. Each milestone is one reviewable PR, built in its own worktree from ${base} after the earlier milestones are merged, so each check must pass from such a checkout. State only what is true on the milestone's own branch: never \"merged\", \"pushed\" or \"PR opened\" (that happens after it is met).`,
    `Then call mcp__auto-claude__${READY_TOOL}. It checks the files and starts the run: goal-mode's loop builds each milestone, and auto-claude pushes it, opens a PR, waits for CI and merges when green.`,
    'Nobody is watching: decide every choice yourself (the recommended or safest option), write each decision with its reason under ## Decisions, and ask only for credentials, payment or an irreversible step.',
  ].join('\n')
}

export function replanText(round: number, finalCheck: string, output: string): string {
  return [
    `[auto-claude] Round ${round}: the queue is done, but the final check still fails.`,
    `Final check: ${finalCheck}`,
    'Its output:',
    '```',
    output.slice(-3000),
    '```',
    'Find what is still missing for the goal in .claude/auto-plan.md and append new milestone lines to .claude/goals.md (leave done and blocked lines as they are). Note the reason under ## Decisions.',
    `Then call mcp__auto-claude__${READY_TOOL}; the run continues with them. Decide yourself; nobody is watching.`,
  ].join('\n')
}

export const POLICY = [
  'auto-claude is running this repository unattended (CLAUDE.md §6.5 rules for an unanswered question apply at once: nobody will answer).',
  '- Decide every choice yourself: the recommended option, or the safest when it is plainly wrong; write it with its reason under ## Decisions in .claude/auto-plan.md.',
  '- Merging is auto-claude\'s: never run gh pr merge or release yourself. Commit your milestone on its goal/* branch; push and PRs happen for you.',
  '- goal-mode\'s loop sets each milestone as the goal itself: never call set_goal or /goal during the run (a goal of yours would hold the loop).',
  '- An irreversible step (deleting data, credentials, payment, a public release) is never taken: call mcp__goal-mode__defer_goal with the reason instead.',
].join('\n')

// The reminder for a run still waiting on its plan, with what the files lack.
export function planNudgeText(nudge: number, max: number, errors: readonly string[]): string {
  return [
    `[auto-claude] Reminder ${nudge}/${max}: the run is still waiting for its plan; nothing is built until mcp__auto-claude__${READY_TOOL} accepts it.`,
    errors.length > 0 ? `What the files lack now:\n- ${errors.join('\n- ')}` : 'The files look ready: call it now.',
    `Write .claude/auto-plan.md and .claude/goals.md as the first prompt of this run asked, then call mcp__auto-claude__${READY_TOOL}. Decide yourself; nobody is watching. After ${max} reminders the run stops.`,
  ].join('\n')
}

// The queue line for repairing a PR whose CI failed or that no longer merges.
export function fixLine(goal: string, pr: number | undefined, reason: string, check: string | undefined, branch: string): string {
  const what = pr !== undefined ? `PR #${pr}` : `branch ${branch}`
  const cause = reason.replace(/\s+/g, ' ').slice(0, 160)

  return `- [ ] Make ${what} ("${goal.slice(0, 60)}") pass again: ${cause} :: check: ${check ?? 'true'} :: base: ${branch}`
}
