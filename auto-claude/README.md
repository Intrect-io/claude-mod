# auto-claude

An unattended run of one repository. Give it an aim in one line, or none at all. Claude then plans the long-term end state, goal-mode's loop builds each milestone, and auto-claude ships each one, merging it when CI is green. Rounds of planning repeat until the plan's final check passes.

```
/auto-claude start [aim]   # e.g. /auto-claude start finish the CLI and its docs
/auto-claude status | stop | resume
```

It depends on [goal-mode](../goal-mode/), which supplies the loop: one worktree per milestone, checks, the evaluator, stuck handling and guards.

## Starting anywhere

- **Not a git repository.** `/auto-claude start` in a plain directory runs `git init -b main`, adds secrets and noise to `.gitignore` (`.env*`, `*.pem`, `*.key`, `node_modules/`, `worktrees/`, `.claude/settings.local.json`), and makes one initial commit of what is there. Plan the empty case too: with no files, the first milestone is the scaffold.
- **Refused.** The home directory, `/`, a directory with more than 3000 files, and a directory that holds other repositories are not one project, so nothing is initialized there.
- **No `origin` remote** (a new repository, or an existing one). Milestones land in the repository's own default branch: the check, a rebase onto it, then `git push . HEAD:<branch>` with `receive.denyCurrentBranch=updateInstead`, which updates the checked-out files in place. There is no PR and no CI, and `.claude/goal-loop.base` is the branch itself. An existing repository must have a clean tracked tree to start.

## A run

1. **Plan.**
   - Claude reads the repository: docs, plan and TODO notes, history, open PRs and issues, failing tests.
   - It writes `.claude/auto-plan.md`: the goal, a `Final check: <command>` line, milestones, and a decisions log.
   - It writes `.claude/goals.md`: one line per milestone, `- [ ] <end state> :: check: <command>`.
   - It calls `auto_plan_ready`, which validates both files. The plan needs a final check, at least 2 milestones, a check on every line and no duplicates.
2. **Build.** auto-claude points the loop at `origin/<default>` through `.claude/goal-loop.base` and grants it one start at a time through `.claude/goal-loop.gate`. The gate is a credit, so goal counts left from earlier runs don't matter. goal-mode builds the milestone in `worktrees/goal-NN-…` and judges it.
3. **Ship.** This runs as auto-claude's own process calls, never as a model turn. Every step that is ready runs in the same tick, so a milestone whose CI is already green is landed and its successor started within one tick. While CI is pending it is looked at every 10 s. A PR that reports no checks yet is waited on for 90 s before "no checks" counts as a repository without CI.
   - **github**: push, `gh pr create`, wait for `gh pr checks`, re-read the PR state, then `gh pr merge --squash --delete-branch`.
   - **local**: run the milestone's check, rebase onto `origin/<default>`, push to it.
   - Right before landing, the milestone's check runs once more in a **fresh checkout**. This is a detached worktree at `worktrees/auto-verify`, made from the branch head fetched from origin (github) or from the rebased commit (local). It is never the builder's worktree, where untracked or ignored files can make a check pass. A check that passes only in the builder's worktree becomes a fix goal, like a red CI.
   - The merged worktree is then removed.
   - When CI fails or the PR conflicts, auto-claude appends a fix goal built on the milestone's branch (`:: base: goal/NN-…`), and the loop builds that next. After 3 failures the milestone is held.
   - **Deploy (opt-in).** When the repository has `.claude/auto-deploy.json`, auto-claude deploys after each merge. See "Deploying" below.
4. **Finish or replan.** When the queue empties, auto-claude runs the final check on a fresh checkout of the merged default branch.
   - If it passes, auto-claude writes a `## Result` section and stops.
   - If it fails, Claude appends new milestones from the check's output (round 2, and so on, up to `maxRounds`).

## Deploying

A repository opts in by committing `.claude/auto-deploy.json`:

```json
{ "command": "bash scripts/deploy.sh", "codeql": "python", "timeoutSec": 600 }
```

- `command` (required) runs with `bash -lc` after each merge. It runs in a fresh detached checkout of the remote default branch (`worktrees/auto-deploy`), which is what was just merged.
- `codeql` (optional) is a language or a list of languages (`python`, `javascript`, …). Before each deploy, auto-claude builds a CodeQL database for each language and runs `<lang>-security-and-quality`. Any error-level result blocks the deploy. Warnings are only reported. The database and the SARIF go to `$TMPDIR`. Set it for repositories with order, payment or credential surfaces (CLAUDE.md §5).
- `timeoutSec` (optional) is 600 by default, and also at most 600.
- The file is read once, when the run starts. A milestone that edits it does not change what that run executes. A broken file keeps the run from starting.
- A failed deploy (a non-zero exit, a timeout, or CodeQL errors) stops the run right there. What is live may then differ from what was merged, so nothing more is merged on top of it. `/auto-claude status` shows the command and the number of deploys so far.

## Autonomy and its limits

- **Choices.** Claude decides every choice itself and records it under `## Decisions`. Irreversible steps (credentials, payment, deleting data, releases) go through `defer_goal` and are never taken.
- **Deploying.** Only auto-claude deploys, and only where `.claude/auto-deploy.json` exists. The model's deploy and release commands stay refused.
- **Merging.** Only auto-claude merges. It adds `gh pr merge`, `gh release` and pushes to `HEAD:main` to `.claude/goal-loop.deny`, so the model is refused them.
- **goal-mode's guards apply too.** Force pushes, direct pushes to main, `reset --hard`, deploy commands, `sudo`, edits outside the worktree and AskUserQuestion are all refused.
- **Caps.** A run stops and reports after `maxMerges` (20) merges, after `maxHours` (24), or after `maxRounds` (3) rounds without the final check passing.
- **Kill switch.** Create `.claude/auto-claude.stop`, or run `/auto-claude stop`. Either one also turns the loop off. `/auto-claude start` and `resume` move a stop file left from an earlier run to `.claude/auto-claude.stop.cleared`, so it cannot end the new run at its first tick.
- **Nothing stalls silently.**
  - A `/goal-mode loop on` that starts nothing is retried with backoff. After 3 tries the person is told the loop's reply.
  - A run still planning gets a reminder every 15 minutes that lists what the plan files lack. After 3 reminders the run stops.
  - A shipping error that repeats is reported once.
  - **Idle nudge.** A run on the `run` phase where nothing was started, shipped or merged for 15 minutes is reported to the person with its cause (the `stalled:` reason, or "idle N min"), again 30 minutes later, and once more, 3 nudges in all (`idleNudges` in the record; any progress resets the count). When the loop is the idle one, the nudge also clears the `loop on` backoff so the grant is asked at once. A goal being built is waiting, not idle. So is a PR whose CI is pending, or whose mergeability GitHub has not decided, for up to 90 minutes: after that the wait is a stall (a check queued for an offline self-hosted runner never finishes), named `PR #N has waited M min for CI` in the nudge and in `stalled:`. The session model is not prompted.
  - `/auto-claude status` ends with a `stalled:` line when the run is not moving. It names the cause and gives the evidence: an orphaned owner (when it last ticked), a granted start the loop does not take (its last `loop on` reply), overdue planning (what the plan files lack), or a shipping error that repeats (its note and count).
  - A run whose owning session has gone quiet for 10 minutes is reported as orphaned in other sessions, and `/auto-claude resume` picks it up there.
  - Only the owning session receives the unattended rules.
- **Reporting.** Progress shows in the status line piece (`auto·R1·M3/7·PR#12`) and in notifications.

Options: `ciMode` (`auto` | `github` | `local`), `maxRounds`, `maxMerges`, `maxHours` and `ciPollSec`.
