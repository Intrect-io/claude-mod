// auto-claude's pure part for planning: plan validation and the prompts that
// start a run and replan it. The queue grammar is generated into ./queue.ts
// from shared/queue.ts.

import { parseQueue } from './queue'
import type { QueueItem } from './queue'

export { parseQueue }
export type { QueueItem }

// `Final check: <command>` in auto-plan.md, backticks optional.
export function finalCheckOf(plan: string): string | undefined {
  const m = plan.match(/^\s*(?:[-*]\s*)?\**final check\**\s*:\s*`?([^`\n]+?)`?\s*$/im)
  return m?.[1]?.trim() || undefined
}

// `<Label>: <value>` in auto-plan.md, backticks optional.
function lineOf(plan: string, label: string): string | undefined {
  const m = plan.match(new RegExp(`^\\s*(?:[-*]\\s*)?\\**${label}\\**\\s*:\\s*\`?([^\`\\n]+?)\`?\\s*$`, 'im'))
  return m?.[1]?.trim() || undefined
}

// What the run deploys, as the plan states it: a command the driver runs after
// each merge, with the smoke check that proves the deploy is live and the
// local scan command run first (or none); or no deploy, with the reason.
export type PlanDeploy = { kind: 'command'; command: string; smoke: string; scan?: string } | { kind: 'none'; reason: string }

const NONE = /^none\s*(?:\((.*)\))?\s*$/i

export function deployOf(plan: string): { deploy?: PlanDeploy; errors: string[] } {
  const errors: string[] = []
  const deploy = lineOf(plan, 'deploy')
  if (deploy === undefined) return { errors: ['auto-plan.md has no "Deploy: `<command>`" line (or "Deploy: none (<why nothing is deployed>)").'] }
  const none = deploy.match(NONE)
  if (none !== null) {
    const reason = (none[1] ?? '').trim()
    if (reason === '') return { errors: ['"Deploy: none" needs its reason: "Deploy: none (<why this repository has nothing to deploy>)".'] }
    return { deploy: { kind: 'none', reason }, errors }
  }
  const smoke = lineOf(plan, 'smoke check')
  if (smoke === undefined) errors.push('a Deploy command needs a "Smoke check: `<command>`" line that passes only when the deployed service works.')
  const scanText = lineOf(plan, 'scan')
  let scan: string | undefined
  if (scanText === undefined) {
    // A plan written before 1.10.0 names CodeQL languages; CodeQL is no longer run, so that line stands for no scan.
    if (lineOf(plan, 'codeql') === undefined) errors.push('a Deploy command needs a "Scan: `<command>`" line (a local tool such as `bandit -q -r src`, `cargo audit`, `gitleaks detect`) or "Scan: none (<reason>)", run before each deploy.')
  } else {
    const snone = scanText.match(NONE)
    if (snone !== null) {
      if ((snone[1] ?? '').trim() === '') errors.push('"Scan: none" needs its reason: "Scan: none (<reason>)".')
    } else scan = scanText
  }
  if (errors.length > 0 || smoke === undefined) return { errors }
  return { deploy: { kind: 'command', command: deploy, smoke, ...(scan !== undefined ? { scan } : {}) }, errors }
}

export type PlanVerdict = { ok: true; finalCheck: string; pending: QueueItem[]; deploy?: PlanDeploy } | { ok: false; errors: string[] }

export const MIN_MILESTONES = 2

// Words that put shipping into a milestone's end state, which the loop judges
// before anything is pushed (measured: "…, merged to main" stayed unmet).
// A start condition in prose ("(start only after X shows DONE)"): the driver
// cannot read it, so it started the line at once and the model deferred it,
// which spent the run's rounds while the awaited job still ran (measured in
// ArtifactNet, 2026-11-09 and 11-15). It belongs in `:: after: <command>`.
// Only the parenthesised prefix seen there: an end state that merely says
// "the server starts only after migrations" is not a wait.
const PROSE_WAIT = /^\([^)]*\bstarts? only (after|when|once)\b/i

// Paths into a milestone worktree (`worktrees/goal-77-...`): such a worktree is
// removed once its branch merges, so a wait that tests or cds into it fails for
// good. Measured in kyte-portal on 2026-11-17: two `:: after: cd .../worktrees/
// goal-77-... && test ...` lines sat 3.5 h and 4 h after their milestones merged.
const WORKTREE_PATH = /(?:[^\s'"`;&|()<>]*\/)?worktrees\/goal-[^\s'"`;&|()<>]+/g

export function worktreeRefs(command: string): string[] {
  return [...new Set(command.match(WORKTREE_PATH) ?? [])]
}

// A wait on the host's load average never passes while the person's own jobs run
// there. Measured 2026-11-19 (intrect-plugin on the Mac): `test "$(sysctl -n
// vm.loadavg | ...)" -lt 8` held a milestone from 01:13 to 11:27 with the load
// at 50-88 from a Python job, CodeQL and Ableton; the same night CC-Router waited
// on `-lt 20` for 19 min. Nothing else may be waiting on it.
const HOST_LOAD = /\b(?:vm\.loadavg|loadavg|uptime)\b|load average/i

export function hostLoadWait(command: string): boolean {
  return HOST_LOAD.test(command)
}

export const HOST_LOAD_HINT = 'the host runs the person\'s own jobs, so a load or uptime test may stay false all night; wait on the awaited job itself (a CI run, a file, a commit on origin/main) and give the line a `:: within:`'

export const WORKTREE_WAIT_HINT = 'milestone worktrees are removed once their branch merges, so test the default branch instead: `git cat-file -e origin/main:<path>` for a file that lands, `git merge-base --is-ancestor <sha> origin/main` for a commit'

const SHIPPING = /\b(merged|merge[sd]? (in)?to|pushed|push(ed)? to|pull request|PR (is )?(open|opened|created|merged)|deployed|is live)\b|머지|병합|푸시|배포(됨|되었|된|완료)/i

// The plan Claude wrote is the contract the run holds it to: a final check,
// and pending milestones that each carry their own runnable check.
// `deployFixed`: .claude/auto-deploy.json decides what is deployed, so the plan need not.
export function validatePlan(plan: string | undefined, queue: string | undefined, firstRound: boolean, deployFixed = false): PlanVerdict {
  const errors: string[] = []
  if (plan === undefined) errors.push('.claude/auto-plan.md is missing.')
  const finalCheck = plan === undefined ? undefined : finalCheckOf(plan)
  if (plan !== undefined && finalCheck === undefined) errors.push('auto-plan.md has no "Final check: `<command>`" line.')
  const deployed = plan === undefined || deployFixed ? undefined : deployOf(plan)
  if (deployed !== undefined) errors.push(...deployed.errors)
  if (queue === undefined) errors.push('.claude/goals.md is missing.')
  const items = queue === undefined ? [] : parseQueue(queue)
  const pending = items.filter(i => i.mark === ' ')
  const need = firstRound ? MIN_MILESTONES : 1
  if (queue !== undefined && pending.length < need) errors.push(`goals.md needs at least ${need} pending milestone line(s) "- [ ] <end state> :: check: <command>"; it has ${pending.length}.`)
  for (const item of pending) {
    if (SHIPPING.test(item.condition)) errors.push(`a milestone says what is true on its own branch; merging, pushing, PRs and deploying happen after it is met: "${item.condition.slice(0, 80)}"`)
    if (item.check === undefined) errors.push(`milestone without a check: "${item.condition.slice(0, 80)}"`)
    // A line put back to wait (wait_until) keeps the branch it was built on.
    if (item.base !== undefined && item.after === undefined) errors.push(`milestones take no ":: base:" (auto-claude sets the base): "${item.condition.slice(0, 80)}"`)
    const refs = [item.after, item.alive].flatMap(c => (c === undefined ? [] : worktreeRefs(c)))
    if (refs.length > 0) errors.push(`a wait that reads ${refs[0]} never passes after that worktree is removed; ${WORKTREE_WAIT_HINT}: "${item.condition.slice(0, 80)}"`)
    if (hostLoadWait(`${item.after ?? ''} ${item.alive ?? ''}`)) errors.push(`a wait on the host's load never passes while the person works there; ${HOST_LOAD_HINT}: "${item.condition.slice(0, 80)}"`)
    if (item.after === undefined && PROSE_WAIT.test(item.condition)) {
      errors.push(`a start condition in prose is never checked, so the line starts at once: write it as ":: after: <shell command that exits 0 once it holds>" after the check (e.g. :: after: grep -q DONE ~/data/x/cache.log): "${item.condition.slice(0, 80)}"`)
    }
  }
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.condition)) errors.push(`duplicate milestone: "${item.condition.slice(0, 80)}"`)
    seen.add(item.condition)
  }
  if (errors.length > 0 || finalCheck === undefined) return { ok: false, errors }

  return { ok: true, finalCheck, pending, ...(deployed?.deploy !== undefined ? { deploy: deployed.deploy } : {}) }
}

export const READY_TOOL = 'auto_plan_ready'
// A run being planned that finds nothing worth a run left ends with this instead.
export const RUN_DONE_TOOL = 'auto_run_done'

// The run before a continued one: its number, its archived plan and queue, its Result line.
export type PreviousRun = { runNo: number; plan: string; queue: string; result: string }

// How the plan states its deploy; `fixed` names the command .claude/auto-deploy.json already set.
function deployRules(fixed: string | undefined): string[] {
  if (fixed !== undefined) {
    return [`Deploying: .claude/auto-deploy.json is committed, so auto-claude deploys with \`${fixed}\` after each merge. Plan no Deploy line; never deploy yourself.`]
  }
  return [
    'The run ends with what it built LIVE: merged, deployed and smoke-checked. Never plan "the person deploys / cuts the release / merges"; that is this run\'s job.',
    'Find how this repository deploys (scripts/deploy*, Makefile targets, wrangler.toml, fly.toml, Dockerfile + k8s manifests, a CI deploy workflow, README) and add to auto-plan.md:',
    '- `Deploy: <one shell command>`: auto-claude runs it after each merge, from a fresh checkout of the default branch (you never deploy yourself; your deploy commands are refused).',
    '- `Smoke check: <one shell command>`: run right after each deploy; it passes only when the deployed service really works (a health endpoint, a version string).',
    '- `Scan: <one shell command>`: a local security tool run before each deploy from the same checkout (python: `bandit -q -r <src>`; rust: `cargo audit`; secrets: `gitleaks detect --no-git`; chain them with &&), or `Scan: none (<reason>)`. It passes on exit 0; a failure only blocks the deploy when its output holds lines the run brought in. CodeQL is not used.',
    'If there is no way to deploy yet, plan the milestone that builds it (the script, its config) before the others need it; deploys start once the command exists on the default branch.',
    'Only a repository with nothing to run anywhere (a library, a document set) writes `Deploy: none (<why>)`. A deploy that needs credentials you do not have is still planned; the milestone that needs them calls defer_goal.',
  ]
}

export function kickoffText(hint: string, base: string, noRemote = false, fixedDeploy?: string, linearBrief?: string, previous?: PreviousRun): string {
  const opening =
    previous === undefined
      ? [
          '[auto-claude] The person started an autonomous run of this repository. Plan it now; build nothing yet.',
          hint !== '' ? `Their aim: ${hint}` : 'No aim was given: finish what this repository is evidently for.',
        ]
      : [
          `[auto-claude] Run ${previous.runNo - 1} finished, so auto-claude goes on by itself: plan run ${previous.runNo} now; build nothing yet. Nobody restarts runs by hand overnight; this is that restart.`,
          `Run ${previous.runNo - 1}: ${previous.result}`,
          `Its plan and milestones are archived in ${previous.plan} and ${previous.queue}. Read its ## Goal, ## Decisions and ## Result first; never plan again what it met.`,
          hint !== '' ? `The person's aim for these runs: ${hint}. Plan the next most valuable step toward its long-term end state.` : 'No aim was given: plan the next most valuable step toward what this repository is evidently for.',
          `If nothing worth a run is left that can be done without the person (what remains needs credentials, a decision, hardware or money), call mcp__auto-claude__${RUN_DONE_TOOL} with that reason instead of planning busywork.`,
        ]
  return [
    ...opening,
    'Read the situation: README and docs, plan.md / IMPROVEMENTS.md / TODO notes, git log and status, open PRs and issues (Linear too if this repo maps to a project), and failing tests.',
    'Aim at the long-term end state of the whole work, not a first step. Then write two files in the repository root:',
    '1. .claude/auto-plan.md: ## Goal (the end state, with its quality bar), a line `Final check: <one shell command that passes only when the whole goal is met>`, the deploy lines below, ## Milestones (ordered, why each), ## Decisions (empty for now).',
    `2. .claude/goals.md: one line per milestone, in order: \`- [ ] <milestone end state> :: check: <shell command that proves it>\`. Each milestone is one reviewable PR, built in its own worktree from ${base} after the earlier milestones are merged, so each check must pass from such a checkout. State only what is true on the milestone's own branch: never \"merged\", \"pushed\", \"PR opened\" or \"deployed\" (that happens after it is met).`,
    'A milestone that needs something with its own clock first (a training run, a cache build, a file an earlier milestone lands on the default branch) adds, after its check, `:: after: <shell command that exits 0 once it is done>` and optionally `:: alive: <command that fails if the job died>` and `:: within: <12h>`. Examples: `:: after: grep -q "CACHE DONE" ~/data/m21/cache.log :: alive: tmux has-session -t m21cache :: within: 8h`, `:: after: git cat-file -e origin/main:docs/m22/final.json`. auto-claude polls it, builds other milestones meanwhile and starts the line when it passes; the run does not end while lines wait. Never write such a condition in prose, and never test the host\'s load or uptime (the person\'s own jobs keep it busy all night).',
    ...deployRules(fixedDeploy),
    ...(linearBrief !== undefined ? [linearBrief] : []),
    `Then call mcp__auto-claude__${READY_TOOL}. It checks the files and starts the run: auto-claude builds each milestone in a worktree, pushes it, opens a PR, waits for CI, merges when green and deploys.`,
    'Nobody is watching: decide every choice yourself (the recommended or safest option), write each decision with its reason under ## Decisions, and ask only for credentials, payment or an irreversible step.',
    ...(noRemote ? [`This repository has no remote: each milestone lands in ${base} in this checkout, judged by its own check, with no PR and no CI. If the repository is empty or nearly so, make the first milestone its scaffold (README, manifest, test setup, one passing test) with a check that proves it runs.`] : []),
  ].join('\n')
}

export function replanText(round: number, finalCheck: string, output: string, linearBrief?: string): string {
  return [
    `[auto-claude] Round ${round}: the queue is done, but the final check still fails.`,
    `Final check: ${finalCheck}`,
    'Its output:',
    '```',
    output.slice(-3000),
    '```',
    ...(linearBrief !== undefined ? [linearBrief] : []),
    'Find what is still missing for the goal in .claude/auto-plan.md and append new milestone lines to .claude/goals.md (leave done and blocked lines as they are). Note the reason under ## Decisions. Keep the Deploy, Smoke check and CodeQL lines (change them only with a decision that says why).',
    `Then call mcp__auto-claude__${READY_TOOL}; the run continues with them. Decide yourself; nobody is watching.`,
  ].join('\n')
}

export const POLICY = [
  'auto-claude is running this repository unattended (CLAUDE.md §6.5 rules for an unanswered question apply at once: nobody will answer).',
  '- Decide every choice yourself: the recommended option, or the safest when it is plainly wrong; write it with its reason under ## Decisions in .claude/auto-plan.md.',
  '- Starting milestones, pushing, PRs, merging and deploying are auto-claude\'s: never run gh pr merge, a release or a deploy yourself, and never ask the person to run /auto-claude, /goal or merge anything. Commit your milestone on its goal/* branch.',
  '- When you are waiting on something (CI, the next milestone, a merge), just end the turn: auto-claude carries on by itself and prompts you when there is work. Never end a turn asking the person to check status.',
  '- Waiting on compute (training, a cache build, a job you launched) is not a blocker and never a reason to defer: inside a milestone call mcp__auto-claude__wait_until with a shell command that exits 0 once it is done; in goals.md write `:: after: <command>` on the line. auto-claude polls it and resumes the work itself.',
  '- auto-claude sets each milestone as the goal itself: never call ProposeGoal or /goal during the run (a session goal would hold the loop).',
  '- An irreversible step (deleting data, credentials, payment, a new public release) is never taken: call mcp__auto-claude__defer_goal with the reason instead.',
  '- Linear issues named at the start of a milestone ("[AX-12] ...") are the driver\'s to move and comment on: read them, never change their state or comment on them, and never create Linear issues during a run (a new issue in the project becomes a milestone of this run).',
].join('\n')

// The reminder for a run still waiting on its plan, with what the files lack.
export function planNudgeText(nudge: number, max: number, errors: readonly string[]): string {
  return [
    `[auto-claude] Reminder ${nudge}/${max}: the run is still waiting for its plan; nothing is built until mcp__auto-claude__${READY_TOOL} accepts it.`,
    errors.length > 0 ? `What the files lack now:\n- ${errors.join('\n- ')}` : 'The files look ready: call it now.',
    `Write .claude/auto-plan.md and .claude/goals.md as the first prompt of this run asked, then call mcp__auto-claude__${READY_TOOL}. Decide yourself; nobody is watching. After ${max} reminders the run stops.`,
  ].join('\n')
}

// The queue line for repairing a deploy that failed after a merge: built from
// the default branch (the milestone's branch is merged and gone). It states
// what is true on its own branch, the cause found and fixed; the deploy itself
// is the driver's to run again after the merge, and that is the proof. No
// check the branch could pass stands for it (the final check passes only once
// the whole goal is met), so the evaluator judges it from the transcript.
export function deployFixLine(command: string, smoke: string | undefined, failure: string, base: string): string {
  const cause = failure.replace(/\s+/g, ' ').slice(0, 200)
  const proof = smoke !== undefined ? `\`${command}\` and its smoke check \`${smoke}\`` : `\`${command}\``
  return `- [ ] The cause of the failed deploy is found and fixed on this branch, with real command output showing both (auto-claude runs ${proof} again after the merge); it failed with: ${cause} :: base: ${base}`
}

// The queue line for repairing a PR whose CI failed or that no longer merges.
export function fixLine(goal: string, pr: number | undefined, reason: string, check: string | undefined, branch: string): string {
  const what = pr !== undefined ? `PR #${pr}` : `branch ${branch}`
  const cause = reason.replace(/\s+/g, ' ').slice(0, 160)

  return `- [ ] Make ${what} ("${goal.slice(0, 60)}") pass again: ${cause} :: check: ${check ?? 'true'} :: base: ${branch}`
}
