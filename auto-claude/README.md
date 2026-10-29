# auto-claude

An unattended run of one repository. Give it an aim in one line, or none at all. Claude then plans the long-term end state, goal-mode's loop builds each milestone, and auto-claude ships each one, merging it when CI is green. Rounds of planning repeat until the plan's final check passes.

```
/auto-claude start [aim]   # e.g. /auto-claude start finish the CLI and its docs
/auto-claude status | stop | resume
```

It depends on [goal-mode](../goal-mode/), which supplies the loop: one worktree per milestone, checks, the evaluator, stuck handling and guards.

## A run

1. **Plan.**
   - Claude reads the repository: docs, plan and TODO notes, history, open PRs and issues, failing tests.
   - It writes `.claude/auto-plan.md`: the goal, a `Final check: <command>` line, milestones, and a decisions log.
   - It writes `.claude/goals.md`: one line per milestone, `- [ ] <end state> :: check: <command>`.
   - It calls `auto_plan_ready`, which validates both files. The plan needs a final check, at least 2 milestones, a check on every line and no duplicates.
2. **Build.** auto-claude points the loop at `origin/<default>` through `.claude/goal-loop.base` and grants it one start at a time through `.claude/goal-loop.gate`. The gate is a credit, so goal counts left from earlier runs don't matter. goal-mode builds the milestone in `worktrees/goal-NN-…` and judges it.
3. **Ship.** This runs as auto-claude's own process calls, never as a model turn.
   - **github**: push, `gh pr create`, wait for `gh pr checks`, re-read the PR state, then `gh pr merge --squash --delete-branch`.
   - **local**: run the milestone's check, rebase onto `origin/<default>`, push to it.
   - The merged worktree is then removed.
   - When CI fails or the PR conflicts, auto-claude appends a fix goal built on the milestone's branch (`:: base: goal/NN-…`), and the loop builds that next. After 3 failures the milestone is held.
4. **Finish or replan.** When the queue empties, auto-claude runs the final check on a fresh checkout of the merged default branch.
   - If it passes, auto-claude writes a `## Result` section and stops.
   - If it fails, Claude appends new milestones from the check's output (round 2, and so on, up to `maxRounds`).

## Autonomy and its limits

- **Choices.** Claude decides every choice itself and records it under `## Decisions`. Irreversible steps (credentials, payment, deleting data, releases) go through `defer_goal` and are never taken.
- **Merging.** Only auto-claude merges. It adds `gh pr merge`, `gh release` and pushes to `HEAD:main` to `.claude/goal-loop.deny`, so the model is refused them.
- **goal-mode's guards apply too.** Force pushes, direct pushes to main, `reset --hard`, deploy commands, `sudo`, edits outside the worktree and AskUserQuestion are all refused.
- **Caps.** A run stops and reports after `maxMerges` (20) merges, after `maxHours` (24), or after `maxRounds` (3) rounds without the final check passing.
- **Kill switch.** Create `.claude/auto-claude.stop`, or run `/auto-claude stop`. Either one also turns the loop off.
- **Nothing stalls silently.**
  - A `/goal-mode loop on` that starts nothing is retried with backoff. After 3 tries the person is told the loop's reply.
  - A run still planning gets a reminder every 15 minutes that lists what the plan files lack. After 3 reminders the run stops.
  - A shipping error that repeats is reported once.
  - A run whose owning session has gone quiet for 10 minutes is reported as orphaned in other sessions, and `/auto-claude resume` picks it up there.
  - Only the owning session receives the unattended rules.
- **Reporting.** Progress shows in the status line piece (`auto·R1·M3/7·PR#12`) and in notifications.

Options: `ciMode` (`auto` | `github` | `local`), `maxRounds`, `maxMerges`, `maxHours` and `ciPollSec`.
