# harness

The user's own Claude harness as one mod (formerly `house-rules`). It covers three things:
- the rules in `~/.claude/CLAUDE.md` and `~/.claude/rules/`, enforced at the tool call instead of hoping the model re-reads them;
- session tooling that used to be shell hooks and prose commands;
- workflow automation for `/commit` and the heartbeat loop.

Each rule feature can be switched with `/harness on|off guards|ship-gate|report-lint|repo-size`. The choice is kept across sessions. `/harness status` shows the current state.

Design rule: a check that is deterministic and unambiguous **refuses**. A heuristic one only adds a **note** for the model, and is promoted once false positives have been measured.

## guards (on)

Refuses or rewrites a single tool call.

**Bash**
- **Attribution:** AI attribution (`Co-Authored-By`, "Generated with Claude") in commits and PR bodies, including `-F` message files.
- **Worktrees:** worktrees outside `<repo>/worktrees/`. A successful add also writes `worktrees/` into `.git/info/exclude`. `EnterWorktree` with `name` is refused, and so is an Agent call with `isolation: "worktree"`.
- **Deletes:** direct `rm`, `unlink`, `rmdir`, `find -delete` and `git clean -f`. Targets in a `trash/` folder, `/tmp` or `$TMPDIR` are allowed.
- **Force push:** refused. `--force-with-lease` is allowed.
- **Python:** without the platform venv, the activation is prefixed. The model is told so once per session, on the first rewritten call. A system interpreter called by absolute path (`/usr/bin/python3`, `/opt/homebrew/bin/python3*`) is refused.
- **LM Studio port:** 1234 is refused; it is 1237.
- **OpenSwarm:** the retired OpenSwarm review gate is refused.
- **Notes only:**
  - a version bump without an open-PR check;
  - a merged branch whose worktree is still there.

**Edit/Write**
- The LM Studio port.
- Secrets (keys, tokens, private keys, `password=`) written into `~/.claude/projects/*/memory/`.

**Linear (CLAUDE.md §1.5)**
- `save_issue` creates and `save_comment` writes only when the user asked for Linear work in this session. Any one of these counts as asking:
  - a prompt naming Linear, 리니어, 이슈 or an issue ID;
  - `/linear-manage` or `/heartbeat-loop`;
  - the heartbeat being on;
  - a live orchestration grant whose `allowed` list mentions Linear.
- A plugin loaded mid-session reads earlier prompts from the transcript, with injected reminders stripped.
- Cancel/Duplicate states and `parentId` (a split) need an AskUserQuestion in the same turn. A state given as a UUID cannot be told apart.
- An unscoped `list_issues` (no project, team, assignee, query, parent, cycle or label) is refused, with the repo's team from `~/.claude/linear.json` as a hint. Only `repo_mapping` is read from that file.

**Trading orders**
- Tools matching the `orderTools` option need an AskUserQuestion in the same turn.
- The default pattern matches `mcp__(pykis|pykiwoom|stockapi)…__…(order|buy|sell|cancel)`.

**ask-default**
- When an AskUserQuestion auto-continues unanswered, the model is told to take each question's `(Recommended)` option.
- If that option is irreversible, it takes the safe hold option instead.

## repo-size (on)

Keeps repos under `~/dev` within a size budget: 5 GB of the whole directory, `.git` and ignored files included. Measured on 2026-10-31, most overruns came from `worktrees/`, `trash/` and `testing/`, which the user's own rules produce. A few came from a `.git` full of loose objects.

- **Measure:** a few seconds after the session starts, `du -k -d 1` and `git count-objects -v` run in the background. The result is cached per repo. Over budget, the status line shows `repo 7.2GB/5.0GB`, and a toast appears when the numbers changed. The next session start gives the model the breakdown (largest dirs, a `git gc` hint when loose objects outweigh packs), once per change. The repo is measured again 5 seconds after a command that may free space (`rm`, `mv`, `find -delete`, `git worktree remove|prune`, `git gc|prune|clean|rm`, `git lfs prune`), every 30 minutes, and by `/repo-size`. So a cleanup clears the status and toasts that the repo is back under budget without waiting for a new session.
- **Refuses:**
  - `git add` and `git commit -a` that would stage a file over 50 MB that is not LFS-tracked (`git check-attr filter`). Ignored files are not counted.
  - `git worktree add` and `EnterWorktree` while the repo is over budget (a measurement older than 10 minutes is taken again first) and worktrees of merged branches are left over. A branch counts as merged if `git branch --merged` lists it, or if its remote branch is `[gone]` (a squash merge).
- **`/repo-size`:** measures now and lists cleanup candidates: leftover worktrees, `trash/` entries older than 30 days, and `git gc` when it would help. It deletes nothing. Emptying `trash/` needs the user's AskUserQuestion approval.
- **Per-repo budget:** `<repo>/.claude/repo-size.json` holds `{ "budgetGB": 8, "ignore": ["db/", "models/"] }`. Use it where data is the work, so the warning does not become permanent noise.

## ship-gate (on)

- After `gh pr merge`, issues the user named in this session that the PR references need a Done transition and an evidence comment before the turn ends. The Stop is blocked up to twice, then only a toast.
- Releases need a `gh pr list` and a CodeQL run in the session first. That covers `gh release create`, tag pushes, `npm|cargo publish` and deploys. `/harness skip-codeql` waives CodeQL for the session.

## report-lint (on)

Nudges once per turn when the final message:
- changed code and ends without `[SELF-AUDIT]`, or has the block but misses one of its four fields;
- ends with a plain-text question, or uses one of the question endings CLAUDE.md §2 names ("어떻게 할까요", "진행해도 될까요", "~할까요") in its last three prose lines. `[FALLBACK: AskUserQuestion unavailable]` exempts this;
- has an English-only prose line.

## Session tooling

- **§6.5 grant check:** a message from another session (`session.receive`, origin peer) gets a verdict line on top. The sender is read from the envelope's `from-name` and checked against `~/.claude/orchestration-grant.json`: expiry and orchestrator name, with the allowed and forbidden lists shown. The name is the sender's own claim, so the verdict grants nothing beyond what §6.5 already allows.
- **Memory GC:** the weekly launchd scan's report is shown as a toast every session. The model reads the counts only when they changed since it last did. This replaced the `memory-gc-inject.sh` SessionStart hook.
- **Statusline sweep:** each mod empties its piece at session end, but the session's folder under `~/.claude/statusline/` stays. Once a day per machine, 10 seconds after a session starts, folders whose pieces are all empty and over a day old, or still filled and over 14 days old (a crashed session), move to `~/.claude/trash/statusline/`. The running session's folder never moves, and one run moves at most 200. The count goes to the debug log.
- **`/repo-status`:** KST time, branch, ahead/behind, last commit, change counts and my open PRs. No model turn.
- **`/slim`:** writes `~/.claude/context/slim-context.md` from the branch, the files this session edited, the diff stat and the issues named, plus a short haiku summary. If the summary fails, only the facts are written.
- **`/repo-size`:** this repo against its size budget, with cleanup candidates. See repo-size above.

## Workflow automation

- **`commit_preflight` tool:** one call returns:
  - branch and default branch, with a main-line warning;
  - staged, unstaged and untracked files;
  - the last commits;
  - whether the branch is on origin, and ahead/behind;
  - an open PR for the branch;
  - issue IDs in the branch name.

  `~/.claude/commands/commit.md` v5 calls it first; the model writes only the message.
- **Heartbeat:** `/harness heartbeat start [5m] | stop | status`. It never starts by itself.
  - A fire needs all of these: a whole interval with no user prompt, no running turn, and goal-mode's loop not active in the repo (`.claude/goal-loop.log` touched within 15 minutes).
  - A fire asks for the heartbeat-loop skill and attaches facts: branch, uncommitted files, running agents and the previous fire's tag.
  - It was once retired as a Stop hook because it fired during collaboration. These conditions are its answer to that.

## Limits

- Regexes over command strings catch mistakes, not evasion. Hooks fail open.
- Cross-plugin ordering (goal-mode's Stop vs this one) is not controlled; plugins cannot order each other.
