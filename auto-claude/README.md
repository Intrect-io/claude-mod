# auto-claude

An unattended run of one repository, through to what it built being live. Give it an aim in one line, or none at all. Claude plans the long-term end state, its milestones and how the repository deploys. The built-in loop builds each milestone in its own worktree and judges it. auto-claude ships each one (merging it when CI is green), deploys it and smoke-checks it. Rounds of planning repeat until the plan's final check passes. Then the next run toward the same aim plans itself (see "Runs that go on by themselves").

```
/auto-claude start [aim]   # e.g. /auto-claude start finish the CLI and its docs
/auto-claude start --once [aim]       # the same, but end when this run's final check passes
/auto-claude start --always-on [aim]  # the same, then stand by and wake for new work
/auto-claude start --queue # build .claude/goals.md as it is: branches only, nothing shipped
/auto-claude standby       # a finished run (or the one going) stands by from now on
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
     - no milestone that says it is merged, pushed or deployed. That happens after the milestone is met;
     - no start condition in prose ("start only after X shows DONE"). It goes in `:: after:` (see "Waiting on compute").
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
   - **The session never rests through CI.** While a PR waits on CI, the next milestone starts at once, **stacked** on that PR's branch: the commit it starts from is recorded. Up to 2 milestones are built ahead this way. They ship in order. When the one before lands (squashed) or is held, the stacked branch runs `git rebase --onto origin/<default> <recorded commit>`, which drops its parent's commits, and is then pushed like any other. A rebased branch is pushed with `--force-with-lease`, since the session may have pushed it before. A stacked branch that does not rebase cleanly gets a fix goal that does the rebase by hand. While a broken deploy is being repaired, nothing new is stacked and nothing stacked ships: the repair, built from the default branch, lands and deploys first. A fix goal (`:: base:`) always starts on its own base.
4. **Finish or replan.** When the queue is done, auto-claude runs the final check on a fresh checkout of the merged default branch. Lines still waiting on their `:: after:` mean the queue is not done: no final check runs and no round is spent until they have started.
   - If it passes, auto-claude deploys once more if a deploy is still due. Then it writes a `## Result` section, and the next run plans itself (see below). With `--once` the run stops here.
   - If it fails, Claude appends new milestones from the check's output (round 2, and so on, up to `maxRounds`).

## Runs that go on by themselves

Measured over 2026-11-11..18, comparing the CC-Router usage dashboard with each repository's log, plans and transcripts:
- 10 runs ended done that week, 4 of them between 22:00 and 08:00 KST.
- None of those 4 was followed by another run before a person came back. de-artifact, for one, was done at 03:06 and started again by hand at 12:54.
- 50 of the week's 83 starts gave no aim.

That restart is now the driver's.

- When a run's final check passes, its `.claude/auto-plan.md` and `.claude/goals.md` are kept as `auto-plan.<yyyymmdd-hhmm>.md` and `goals.<…>.md` (git-ignored), and the same session is asked to plan the next run toward the same aim. The prompt names the finished run's Result and its kept files, so the next plan builds on its `## Decisions` and does not plan again what it met. The log gets a `next-run` event.
- A planner that finds nothing worth a run left without the person (credentials, a decision, hardware, money) calls `mcp__auto-claude__auto_run_done` with the reason, instead of planning busywork. The run ends as done with that reason. The tool is refused once a run is under way.
- It goes on only while it makes progress, and within caps over the last 24 h:
  - A run that merged nothing ends as done: another would likely do the same.
  - `maxRunsPerDay` (6) runs started in 24 h.
  - `maxMergesPerDay` (20) merges in 24 h, shared with always-on runs.
  - A `.claude/auto-claude.stop` in place.
  When one of these holds, the run ends as done and the notice says which ("no next run: …"). A run that stops (a cap, failed deploys, `/auto-claude stop`) never goes on by itself.
- Every run does this unless started with `--once`, or unless the `continueRuns` option is off. Runs started before 1.6.0 do it too. An always-on run stands by instead. A `--queue` run has no plan to continue.
- `status` shows the run's number in the chain and the count against the cap. A run's end (`run-done`, `run-stopped`) is now in `.claude/goal-loop.log` too.

## Always on

With `--always-on` (or the `alwaysOn` option), a run does not end when its final check passes. It **stands by**: still on, but with no model turn, while the driver polls what can give it work. Each new thing becomes a queue line, and a queue line wakes the run for a new **cycle**. The design follows [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents): sleep without tokens, wake on events and timers, keep memory outside the conversation, send little.

| source | polled | becomes |
| --- | --- | --- |
| Linear (mapped project) | every 10 min, as during a run | `- [ ] [AX-12] …` (see "Linear") |
| The plan's `Smoke check:` | every `healthEveryMin` (30) | 2 failures in a row: the deploy repair line, built from the default branch first |
| The default branch's CI (github mode) | every `githubEveryMin` (10), and at once on entering standby | a failed run on the branch's current tip: `- [ ] [ci:<run>] The "<workflow>" workflow passes on main again …` |
| Open GitHub issues labelled `issueLabel` (`auto-claude`) | with the CI poll | `- [ ] [gh#12] <title>: what GitHub issue #12 asks is resolved on this branch …`; closed with a comment when it merges |

- **Dedupe.** Each event has an id (`ci:<run>`, `gh#<n>`) and a stamp; an id is queued once, at most 5 lines per poll. A GitHub issue's later changes (comments, edits) queue nothing.
- **Trust.** Labelling needs triage access, so the label is the gate: an issue is work when someone who may label it says so, once. Only its number and title go into the line, with `::` and brackets removed, so a title cannot add a check or a base. The model reads the issue itself while building; its body is still third-party text, so label only issues whose body you would hand the run. Peer messages and webhook text do not wake a run.
- **`--once`** opts a single start out when `alwaysOn` is the default.
- **Waking.** Only when the session has had no turn for 2 min: a person may use the session while it stands by. A cycle builds, ships and deploys like any run, without a new planning round; its final check passing stands it by again. A failing one replans, as a run does.
- **Standing by owns nothing.** The guards and the unattended policy are off, `.claude/auto-claude.on` says `on: false, phase: standby`, and the watchdog's idle notices are quiet.
- **Caps.** `maxMerges` and `maxHours` count per cycle; standby time counts toward neither. `maxMergesPerDay` (20) holds a wake back while the last 24 h hold that many merges, told once. 3 deploys failing in a row still stop the run.
- **Memory.** Each cycle adds one line under `## Cycles` in `auto-plan.md`: what woke it, what merged, was held and deployed. On entering standby the session is compacted once (when its context is 30% full or more), keeping the goal, decisions and cycles.
- **Quiet.** In standby a person is told only of a wake (and why), a cycle's end, a failing smoke check or GitHub poll, and the daily cap.
- **Limits.** The worker is a session: if it exits, nothing polls until another session of the repository takes the run over (below) or `/auto-claude resume`. An external supervisor, Remote Control or webhook inboxes, and answering a deferred milestone are not part of this.

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
- `CodeQL:` names the languages scanned before each deploy (`<lang>-security-and-quality`), or says `none (<reason>)`. An error-level result the run brought in blocks the deploy. One that was already there before the run is reported and does not block. Warnings are only reported. The database and the SARIF go to `$TMPDIR`.
  - "Before the run" is the default branch's commit when the run started. It is scanned once, in `worktrees/auto-codeql-base`, the first time a deploy's scan finds an error. After that the record keeps the set of known results: what the last passing scan found. A result is matched by its rule, its file and CodeQL's `primaryLocationLineHash` (else its message), so moving it to another line does not make it new.
  - Why: blocking on results that were live before the run stopped whole runs. intrect-platform stopped on 48 old results on 2026-11-17. kyte-portal deferred for 112 h on the same cause.
- A repository with nothing to run anywhere (a library, a document set) writes `Deploy: none (<reason>)`. `none` without a reason is not accepted.
- When there is no way to deploy yet, the plan's early milestones build it. While a script the command names (`bash scripts/deploy.sh`, `./deploy`) is missing from the default branch, the deploy waits ("a deploy is due" in `status`) instead of failing. It runs once the script lands, and at the latest before the run is done.
- The lines are fixed when `auto_plan_ready` accepts the plan. A milestone that edits them does not change what the run executes. A replan may change them, and the change is announced.

A committed `.claude/auto-deploy.json` takes precedence: the person decided. The plan then needs no Deploy line. The file is read once, when the run starts. A broken file keeps the run from starting.

```json
{ "command": "bash scripts/deploy.sh", "smoke": "curl -fsS https://x/health", "codeql": "python", "timeoutSec": 600 }
```

`timeoutSec` is 600 by default, and also at most 600.

**A failed deploy does not stop the run.** That covers a non-zero exit, a timeout, new CodeQL errors and a failed smoke check.
- A milestone that repairs the deploy goes into the queue first. It is built from the default branch, because the shipped branch is merged and gone, and it is judged by the final check.
- It is merged like any milestone, and the deploy then runs again.
- 3 deploys failing in a row stop the run. Nothing more is merged on top of a broken live service.

## Linear

A run keeps the repository's Linear project in step, through the session's own `linear-server` MCP connection (no API key is read). Only a repository mapped to a project syncs: `repo_mapping.<folder name>.projectId` or `projectName` in `~/.claude/linear.json`. A team alone is shared by many repositories, so it is not enough. An unmapped repository syncs nothing, and `status` says `linear: off`.

- **Planning.** The planning prompt (and each replan) lists the project's open issues: triage, backlog, unstarted and started. A milestone that resolves issues starts with their IDs: `- [ ] [AX-12] <end state> :: check: <command>`. An open issue the plan leaves out gets a line under `## Decisions`.
- **While the run goes.** Every 10 minutes, and once more before the run may finish, the driver reads the open issues. It also reads the newest comments on the 25 most recently changed issues and on every issue the run has a line for. A new comment on an older issue waits until the issue itself changes. Every open issue counts as covered from the moment the run starts, so comments written before it never count. A run that started unmapped (or under an older version) adopts the project on its next tick. Comments do not move an issue's `updatedAt` (measured 2026-11-13), so they are read on their own. An issue that is new or changed since the run last covered it gets a queue line, at most 5 per sync. The line has no check, so the evaluator judges it: `- [ ] [AX-12] <title>: what Linear AX-12 asks is resolved on this branch (…)`. A change to an issue whose line is still pending is covered by that line. A change to an issue being built or shipped is looked at when it merges. Each issue gets at most 2 follow-up lines.
- **Closed issues.** An issue closed while its line waits (cancelled, done elsewhere) blocks that line. The driver never moves a closed issue back to `started`. At merge, a closed issue only gets the evidence comment.
- **No new issues during a run.** The model is told not to create issues, and harness refuses an issue create the user did not ask for. Otherwise a new issue would become a milestone of the same run.
- **Write-back.** A milestone that starts moves its issues to `started`. One that merges moves them to `completed`, with a comment naming the PR. If the issue changed in Linear while the milestone was built, it stays open instead, with a comment and a follow-up line. A held or blocked milestone gets a comment only. The driver's comments start with `[auto-claude]` and never count as changes. The model is told never to change these issues' state or comment on them.
- **Signal for other mods.** Each tick writes `.claude/auto-claude.on` (`{ on, phase, at }`, git-excluded), so other mods can tell whether a run owns the repository.
- `--queue` runs neither read nor write Linear.

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
- **Caps.** A run stops and reports after `maxMerges` (20) merges, after `maxHours` (24) of working time, or after `maxRounds` (3) rounds without the final check passing. Time spent with nothing to do but wait on `:: after:` lines does not count toward `maxHours`, up to `maxWaitHours` (72) of it.
- **Kill switch.** Create `.claude/auto-claude.stop`, or run `/auto-claude stop`. Either one ends the loop's milestone as well: it is no longer judged, and its guards lift. `/auto-claude start` and `resume` move a stop file left from an earlier run to `.claude/auto-claude.stop.cleared`. `resume` goes back to the phase the run stopped in: planning stays planning.

## Nothing waits on the person

A run never asks the person to look at `status` or to run a command. When something stops moving, the watchdog acts on the cause. It reports what it did, and holds what stays stuck so the run goes on.

| what stops | what happens |
| --- | --- |
| A milestone is open, but the session has had no turn for 1 min: the model ended its turn to "wait", a prompt was dropped, an interrupt, or a stop the judge could not read | The milestone's prompt is sent again, after 1, 3 and 6 min of quiet. At 12 min, the milestone is blocked and the next one starts. A stop being judged, or a retry pause, is not quiet. Turns are tracked with `turn.start` / `turn.complete`. |
| The model waits inside a turn | Refused while a run is on: `sleep` of 60 s or more (or a computed duration), `gh run watch`, `gh pr checks --watch`, `Monitor`, `CronCreate` and `ScheduleWakeup`. auto-claude watches CI, merges and deploys itself, and prompts the session when there is work. The refusal points to `wait_until` for a job with its own clock. Shorter sleeps (a check waiting for a server) pass. |
| A milestone needs a training run or a cache build to finish | The line waits on its `:: after:` command, polled every 3 min, while other lines are built (see "Waiting on compute"). The run neither ends nor counts it as idle. |
| A waited-on job died, or its wait runs past its `within` | `:: alive:` failing 2 polls in a row, or the wait passing its `within`, sends the model one prompt with the last poll's output to look at the job and relaunch it or fix the line. Past twice its `within`, the line is held. |
| A shipping error to diagnose while the session builds another milestone | The diagnosis prompt waits until that milestone is done, so the stop judge never judges the wrong work. Nothing is held before the model was asked and had 10 min to act (after an hour unasked, the hold goes ahead). |
| Planning ends without `auto_plan_ready` | A reminder 1 min after that turn ended, listing what the plan files lack (15 min at most otherwise). After 3, the run stops. |
| An SSH remote refuses the push (`Permission denied (publickey)`) | The push goes to the https URL of the same repository. |
| The same shipping error, check after check | At 5 checks, the session model gets the error and what was tried, and fixes what it can (gh auth, remotes, `gh repo set-default`). At 10, the milestone is held and the run goes on. |
| A PR closed under the run | It is opened again once, then held. |
| CI that does not finish | After 90 min, or 30 min when every run of the branch is still queued (no runner), its runs are cancelled and run again once. If it still does not finish 90 min later, the milestone is held. |
| The same cause holds two milestones in a row (no runner, gh not logged in) | The run stops and names the cause, instead of holding every later milestone. |
| A tick that fails 3 times in a row | Reported once with its error. `stalled: every tick fails` stays in `status` until a tick gets through. |
| Nothing started, shipped or merged for 15 min | The person is told the cause and that the watchdog is on it: at 15 min, 30 min later, and once more. |
| The owning session goes quiet for 10 min (exited, replaced after a reboot, or the person moved to another session) | Any session of the same repository takes the run over by itself, with the milestone being built, once it has been free for 2 min (no turn running), and says so. A busy session only reports the run as orphaned, until it is free. A `.claude/auto-claude.stop` left in place keeps it reported, not taken. Two sessions claiming at once: the claim still in the store after 3 s goes on. `/auto-claude resume` takes it over at once. |

`/auto-claude status` ends with a `stalled:` line naming the cause whenever the run is not moving. Only the owning session receives the unattended rules. Progress shows in the status line piece (`auto·R1·M3/7·PR#12`) and in notifications.

## Waiting on compute

A milestone may need something with its own clock first: a training run, a cache build, or a file another milestone lands on the default branch. The driver watches it; the model never schedules its own wake-up.

```
- [ ] record the M21 cache :: check: pytest -q tests/test_m21.py :: after: grep -q "CACHE DONE" ~/data/m21/cache.log :: alive: tmux has-session -t m21cache :: within: 8h
- [ ] the M22 verdict :: check: python -m src.m22.check final :: after: git cat-file -e origin/main:docs/m22/runs.json
```

- **`:: after: <command>`** must exit 0 before the line starts. auto-claude runs it from the repository root every 3 min (30 s timeout), fetching first when it names `origin/`. Lines that wait are skipped; the others are built meanwhile.
- **`:: alive: <command>`** (optional) exits 0 while the awaited job runs. Failing 2 polls in a row asks the model, once, to look at the job.
- **`:: within: <90m | 12h | 2d>`** (optional): past it the model is asked to look; past twice it the line is held. A line without one is still asked about, once, after 12 h, and never held.
- `after` and `alive` run from the repository root, never from a worktree, both when polled and when `wait_until` checks them.
- **They never name a milestone worktree** (`worktrees/goal-…`). Those worktrees are removed once their branch merges, so the wait could never pass. Test the default branch instead: `git cat-file -e origin/main:<path>` for a file that lands, `git merge-base --is-ancestor <sha> origin/main` for a commit. The plan check and `wait_until` refuse such paths. A line edited into the queue later is caught when it is polled: when a worktree it names is gone, the model is asked to rewrite it at once, instead of after its `within` or 12 h. Measured in kyte-portal on 2026-11-17: two such lines sat 3.5 h and 4 h after their milestones merged.
- The fields go after the check, in this order, with `:: base:` last.
- **`mcp__auto-claude__wait_until`** does the same from inside a milestone: `{ until, alive?, within?, reason }`. It is refused if `until` already passes or the worktree has uncommitted changes. At the next stop the line goes back to the queue with `:: after:` and `:: base: <its branch>`, so it restarts from the work built so far. A milestone that was stacked keeps the commit it was stacked on, so its restarted branch is rebased off the parent like any stacked one.
- `/auto-claude status` lists each wait, how long it has waited and its last poll; the status line piece shows `·waitN`.

Measured in ArtifactNet (2026-11-09 to 11-15): lines carried prose start conditions the driver could not read, so each was started at once and deferred by the model. With every line deferred, the final check failed and a round was spent; three rounds went in 25 minutes, the run stopped, and nothing resumed it when the cache finished hours later.

## The loop

- **Stuck.** 5 unmet checks in one turn, two unreadable verdicts, or an evaluator that fails: the loop waits 2 minutes, then sends a "change your approach" prompt, at most twice. After that the line is marked `[!]` and the run moves on.
- **Deferring.** The model may call `mcp__auto-claude__defer_goal` for an external blocker after 2 failed checks. The deferral is applied at the next stop. Waiting on compute is not a blocker: it uses `wait_until`.
- **Evaluator.** Each call takes about 2–20 s. It is billed to the session's credentials but does not appear in `/cost`. A transcript over the 4 MiB read cap is judged by a fork of the session instead.
- **Files.** `.claude/goals.md`, `.claude/goal-loop.log` (JSONL, its last 2000 lines) and `.claude/goal-loop.deny` are excluded from git through `.git/info/exclude`, along with `worktrees/`.
- **`--queue`.** `/auto-claude start --queue` builds the queue you wrote, line by line, with the same loop. Nothing is pushed, merged or deployed, and the branches are left for review, as goal-mode's `loop on` did.

## From goal-mode

- **The loop moved.** `/goal-mode loop on` is now `/auto-claude start --queue`. Inside a run, the driver starts each milestone itself.
- **Gone:** `.claude/goal-loop.gate`, `.claude/goal-loop.base` and the `loop on` hand-off. Their stalls went with them: a start granted but not taken, a gate counted from the wrong base.
- **Renamed:** `mcp__goal-mode__defer_goal` is now `mcp__auto-claude__defer_goal`.
- **Session goals** (`set_goal`, `/goal-mode set|auto|clear` and the outcome nudges) are gone. Use Claude Code's `/goal` and `ProposeGoal`.
- **A run already going** when 1.0 loads keeps its milestone. The loop's state lived in goal-mode's store, which this plugin cannot read, so the open milestone is found again from the last `start` in `.claude/goal-loop.log` and prompted again. New branches number above the highest existing `goal/NN-*`.

Options: `ciMode` (`auto` | `github` | `local`), `maxRounds`, `maxMerges`, `maxHours`, `maxWaitHours`, `ciPollSec`, `continueRuns` and `maxRunsPerDay` for runs that go on by themselves, and for always-on runs `alwaysOn`, `healthEveryMin`, `githubEveryMin`, `issueLabel` and `maxMergesPerDay`.
