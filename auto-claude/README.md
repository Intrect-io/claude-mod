# auto-claude

An unattended run of one repository, through to what it built being live. Give it an aim in one line, or none at all. Claude plans the long-term end state, its milestones and how the repository deploys. The built-in loop builds each milestone in its own worktree and judges it. auto-claude ships each one (merging it when CI is green), deploys it and smoke-checks it. Rounds of planning repeat until the plan's final check passes.

```
/auto-claude start [aim]   # e.g. /auto-claude start finish the CLI and its docs
/auto-claude start --queue # build .claude/goals.md as it is: branches only, nothing shipped
/auto-claude status | stop | resume
```

goal-mode merged into auto-claude in 1.0.0 (see "From goal-mode" below). Its loop (worktrees, checks, the evaluator, stuck handling and guards) lives in `hooks/loop.ts`. Its session goals are gone: Claude Code's own `/goal` and `ProposeGoal` cover them.

## Starting anywhere

- **Not a git repository.** `/auto-claude start` in a plain directory runs `git init -b main`, adds secrets and noise to `.gitignore` (`.env*`, `*.pem`, `*.key`, `node_modules/`, `worktrees/`, `.claude/settings.local.json`), and makes one initial commit of what is there. Plan the empty case too: with no files, the first milestone is the scaffold.
- **Refused.** The home directory, `/`, a directory with more than 3000 files, and a directory that holds other repositories are not one project, so nothing is initialized there.
- **No `origin` remote** (a new repository, or an existing one). Milestones land in the repository's own default branch: the check, a rebase onto it, then `git push . HEAD:<branch>` with `receive.denyCurrentBranch=updateInstead`, which updates the checked-out files in place. There is no PR and no CI, and milestones start from the branch itself. An existing repository must have a clean tracked tree to start.

## A run

1. **Plan.**
   - Claude reads the repository: docs, plan and TODO notes, history, open PRs and issues, failing tests.
   - It writes `.claude/auto-plan.md` with these parts:
     - the goal;
     - a `Final check: <command>` line;
     - how the run deploys (see "Deploying");
     - the milestones;
     - a decisions log.
   - It writes `.claude/goals.md`: one line per milestone, `- [ ] <end state> :: check: <command>`.
   - It calls `auto_plan_ready`, which validates both files. The plan needs all of these:
     - a final check;
     - a Deploy line;
     - at least 2 milestones, with a check on every line and no duplicates;
     - no milestone that says it is merged, pushed or deployed. That happens after the milestone is met.
2. **Build.** When nothing is being built or shipped, auto-claude starts the next pending line itself. Lines with `:: base:` go first.
   - The line gets its own worktree, `worktrees/goal-NN-…` on branch `goal/NN-…`, made from `origin/<default>`, or from the line's `:: base:`.
   - Claude gets a kickoff prompt. At every stop, the loop runs the line's check in the worktree and refuses uncommitted changes. Then an independent evaluator (`claude-sonnet-5-5`) judges the milestone from the transcript.
   - The loop marks the line `[x]` or `[!]`. It logs to `.claude/goal-loop.log`, which is also where the driver reads what happened.
3. **Ship.** This runs as auto-claude's own process calls, never as a model turn. Every step that is ready runs in the same tick. While CI is pending it is looked at every 10 s. A PR that reports no checks yet is waited on for 90 s before "no checks" counts as a repository without CI.
   - **github**: push, `gh pr create`, wait for `gh pr checks --required`, re-read the PR state, then `gh pr merge --squash --delete-branch`.
     - Only required checks decide. A failing check that is not required does not block the merge. Where no check is required, every check counts.
     - A merge whose reply is lost (a 502 after GitHub merged it) is looked up again and counts as merged.
   - **local**: run the milestone's check, rebase onto `origin/<default>`, push to it.
   - Right before landing, the milestone's check runs once more in a **fresh checkout**: a detached worktree at `worktrees/auto-verify`, made from the branch head fetched from origin (github) or from the rebased commit (local). A check that passes only in the builder's worktree becomes a fix goal, like a red CI.
   - When CI fails or the PR conflicts, auto-claude appends a fix goal built on the milestone's branch (`:: base: goal/NN-…`), and the loop builds that next. After 3 failures the milestone is held.
   - **Deploy.** After each merge, as the plan says (see "Deploying").
   - **The session never rests through CI.** While a PR waits on CI, the next milestone starts at once, **stacked** on that PR's branch: the commit it starts from is recorded. Up to 2 milestones are built ahead this way. They ship in order. When the one before lands (squashed) or is held, the stacked branch runs `git rebase --onto origin/<default> <recorded commit>`, which drops its parent's commits, and is then pushed like any other. A stacked branch that does not rebase cleanly gets a fix goal that does the rebase by hand. Nothing is stacked while the live deploy is broken: its repair goes first. A fix goal (`:: base:`) always starts on its own base.
4. **Finish or replan.** When the queue is done, auto-claude runs the final check on a fresh checkout of the merged default branch.
   - If it passes, auto-claude deploys once more if a deploy is still due. Then it writes a `## Result` section and stops.
   - If it fails, Claude appends new milestones from the check's output (round 2, and so on, up to `maxRounds`).

## Deploying

The run's end is what it built **live**: merged, deployed and smoke-checked. A plan that leaves the deploy or the release to the person is not accepted.

Claude finds how the repository deploys (`scripts/deploy*`, Makefile targets, `wrangler.toml`, `fly.toml`, Dockerfile and k8s manifests, a CI deploy workflow, the README) and writes three lines in `auto-plan.md`:

```
Deploy: `bash scripts/deploy.sh`
Smoke check: `curl -fsS https://api.example.com/health`
CodeQL: python
```

- `Deploy:` is run by auto-claude after each merge, with `bash -lc`, in a fresh detached checkout of the default branch (`worktrees/auto-deploy`). The model never deploys. Its deploy and cluster commands stay refused, except read-only looks such as `kubectl get|logs|describe`, `fly status|logs` and `wrangler tail`, which it can use to debug a failed smoke check.
- `Smoke check:` runs right after the deploy. It must pass only when the deployed service really works.
- `CodeQL:` names the languages scanned before each deploy (`<lang>-security-and-quality`), or says `none (<reason>)`. Any error-level result blocks the deploy. Warnings are only reported. The database and the SARIF go to `$TMPDIR`.
- A repository with nothing to run anywhere (a library, a document set) writes `Deploy: none (<reason>)`. `none` without a reason is not accepted.
- When there is no way to deploy yet, the plan's early milestones build it. While a script the command names (`bash scripts/deploy.sh`, `./deploy`) is missing from the default branch, the deploy waits ("a deploy is due" in `status`) instead of failing. It runs once the script lands, and at the latest before the run is done.
- The lines are fixed when `auto_plan_ready` accepts the plan. A milestone that edits them does not change what the run executes. A replan may change them, and the change is announced.

A committed `.claude/auto-deploy.json` takes precedence: the person decided. The plan then needs no Deploy line. The file is read once, when the run starts. A broken file keeps the run from starting.

```json
{ "command": "bash scripts/deploy.sh", "smoke": "curl -fsS https://x/health", "codeql": "python", "timeoutSec": 600 }
```

`timeoutSec` is 600 by default, and also at most 600.

**A failed deploy does not stop the run.** That covers a non-zero exit, a timeout, CodeQL errors and a failed smoke check.
- A milestone that repairs the deploy goes into the queue first. It is built from the default branch, because the shipped branch is merged and gone, and it is judged by the final check.
- It is merged like any milestone, and the deploy then runs again.
- 3 deploys failing in a row stop the run. Nothing more is merged on top of a broken live service.

## Autonomy and its limits

- **Choices.** Claude decides every choice itself and records it under `## Decisions`. Irreversible steps (credentials, payment, deleting data, a new public release) go through `mcp__auto-claude__defer_goal` and are never taken.
- **Merging and deploying.** Only auto-claude merges and deploys. It adds `gh pr merge`, `gh release` and pushes to `HEAD:main` to `.claude/goal-loop.deny`, so the model is refused them.
- **Guards** (in the session running the run):
  - **Throughout the run**, including planning: AskUserQuestion, EnterPlanMode and `ProposeGoal` are refused. A session `/goal` would block the loop's stops, so `/auto-claude start` and `resume` also run `/goal clear` where the engine has `/goal`.
  - **While a milestone is built**, these are refused:
    - force pushes, and pushes other than a `goal/*` branch;
    - `git reset --hard`;
    - `sudo`;
    - deploy and cluster commands (read-only looks such as `kubectl get` are allowed);
    - `rm -rf` outside the worktree;
    - edits in the repository outside the worktree;
    - any regex in `.claude/goal-loop.deny`.
- **Caps.** A run stops and reports after `maxMerges` (20) merges, after `maxHours` (24), or after `maxRounds` (3) rounds without the final check passing.
- **Kill switch.** Create `.claude/auto-claude.stop`, or run `/auto-claude stop`. Either one ends the loop's milestone as well: it is no longer judged, and its guards lift. `/auto-claude start` and `resume` move a stop file left from an earlier run to `.claude/auto-claude.stop.cleared`. `resume` goes back to the phase the run stopped in: planning stays planning.

## Nothing waits on the person

A run never asks the person to look at `status` or to run a command. When something stops moving, the watchdog acts on the cause. It reports what it did, and holds what stays stuck so the run goes on.

| what stops | what happens |
| --- | --- |
| A milestone is open, but the session has had no turn for 1 min: the model ended its turn to "wait", a prompt was dropped, an interrupt, or a stop the judge could not read | The milestone's prompt is sent again, after 1, 3 and 6 min of quiet. At 12 min, the milestone is blocked and the next one starts. A stop being judged, or a retry pause, is not quiet. Turns are tracked with `turn.start` / `turn.complete`. |
| The model waits inside a turn | Refused while a run is on: `sleep` of 60 s or more (or a computed duration), `gh run watch`, `gh pr checks --watch`, `Monitor`, `CronCreate` and `ScheduleWakeup`. auto-claude watches CI, merges and deploys itself, and prompts the session when there is work. Shorter sleeps (a check waiting for a server) pass. |
| A shipping error to diagnose while the session builds another milestone | The diagnosis prompt waits until that milestone is done, so the stop judge never judges the wrong work. |
| Planning ends without `auto_plan_ready` | A reminder 1 min after that turn ended, listing what the plan files lack (15 min at most otherwise). After 3, the run stops. |
| An SSH remote refuses the push (`Permission denied (publickey)`) | The push goes to the https URL of the same repository. |
| The same shipping error, check after check | At 5 checks, the session model gets the error and what was tried, and fixes what it can (gh auth, remotes, `gh repo set-default`). At 10, the milestone is held and the run goes on. |
| A PR closed under the run | It is opened again once, then held. |
| CI that does not finish | After 90 min, or 30 min when every run of the branch is still queued (no runner), its runs are cancelled and run again once. If it still does not finish 90 min later, the milestone is held. |
| The same cause holds two milestones in a row (no runner, gh not logged in) | The run stops and names the cause, instead of holding every later milestone. |
| A tick that fails 3 times in a row | Reported once with its error. `stalled: every tick fails` stays in `status` until a tick gets through. |
| Nothing started, shipped or merged for 15 min | The person is told the cause and that the watchdog is on it: at 15 min, 30 min later, and once more. |
| The owning session goes quiet for 10 min | Other sessions report the run as orphaned. `/auto-claude resume` takes it over there, including the milestone being built. |

`/auto-claude status` ends with a `stalled:` line naming the cause whenever the run is not moving. Only the owning session receives the unattended rules. Progress shows in the status line piece (`auto·R1·M3/7·PR#12`) and in notifications.

## The loop

- **Stuck.** 5 unmet checks in one turn, two unreadable verdicts, or an evaluator that fails: the loop waits 2 minutes, then sends a "change your approach" prompt, at most twice. After that the line is marked `[!]` and the run moves on.
- **Deferring.** The model may call `mcp__auto-claude__defer_goal` for an external blocker after 2 failed checks. The deferral is applied at the next stop.
- **Evaluator.** Each call takes about 2–20 s. It is billed to the session's credentials but does not appear in `/cost`. A transcript over the 4 MiB read cap is judged by a fork of the session instead.
- **Files.** `.claude/goals.md`, `.claude/goal-loop.log` (JSONL, its last 2000 lines) and `.claude/goal-loop.deny` are excluded from git through `.git/info/exclude`, along with `worktrees/`.
- **`--queue`.** `/auto-claude start --queue` builds the queue you wrote, line by line, with the same loop. Nothing is pushed, merged or deployed, and the branches are left for review, as goal-mode's `loop on` did.

## From goal-mode

- **The loop moved.** `/goal-mode loop on` is now `/auto-claude start --queue`. Inside a run, the driver starts each milestone itself.
- **Gone:** `.claude/goal-loop.gate`, `.claude/goal-loop.base` and the `loop on` hand-off. Their stalls went with them: a start granted but not taken, a gate counted from the wrong base.
- **Renamed:** `mcp__goal-mode__defer_goal` is now `mcp__auto-claude__defer_goal`.
- **Session goals** (`set_goal`, `/goal-mode set|auto|clear` and the outcome nudges) are gone. Use Claude Code's `/goal` and `ProposeGoal`.
- **A run already going** when 1.0 loads keeps its milestone. The loop's state lived in goal-mode's store, which this plugin cannot read, so the open milestone is found again from the last `start` in `.claude/goal-loop.log` and prompted again. New branches number above the highest existing `goal/NN-*`.

Options: `ciMode` (`auto` | `github` | `local`), `maxRounds`, `maxMerges`, `maxHours` and `ciPollSec`.
