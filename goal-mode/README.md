# goal-mode

Lets Claude set its own session goal in Claude Code's own `/goal`, and runs an unattended loop of queued goals.

**Every session goal goes to `/goal`.** `set_goal`, `/goal-mode set` and `/goal-mode auto` all end in `/goal <condition> (check: …)`. That means:

- The goal shows exactly as your own `/goal` would: `◎ /goal active`, the built-in evaluator, the `✔ Goal achieved` card, `/goal clear`.
- This plugin chooses goals (`auto`, the nudges) and runs the loop. It judges only the loop's queue goals itself.
- A `set_goal` call made mid-turn lands as that turn ends, because the engine refuses a command from inside a turn. Where the engine's `ProposeGoal` answers, the goal is set at once instead. The plugin hands off one goal per turn.
- The condition, with its check folded in, is limited to 500 characters.
- `/goal-mode clear` also runs `/goal clear`.
- On a Claude Code without `/goal`, session goals are unavailable: a debug log line at session start, and `set_goal`, `/goal-mode set` and `/goal-mode auto` say so. The nudges stay quiet there. The loop still works.
- A goal an earlier version of this plugin held itself moves to `/goal` at session start, or is dropped where there is no `/goal`.

- **Setter**: the model calls `mcp__goal-mode__set_goal` with one measurable end state (and optionally its check) when the user asked for a verifiable, multi-turn outcome. No approval prompt; the model reports the goal in one line. Refused in plan mode, while a loop runs, or when Claude Code's native `ProposeGoal` tool is available (the model is told to use that instead).
- **User commands**:
  - `/goal-mode auto [hint]` (or a bare `/goal-mode set`) hands the goal to Claude, as a long-term one. Claude reads the situation (this conversation, any approved plan, the repository state, unfinished work) and aims at the end state of the whole plan the hint and project point to, never a first step or a quick task. It writes the milestones to `.claude/goal-plan.md`, and sets one measurable goal that names that file, so every milestone must be done. It asks nothing (no sizes, budgets or choices), tells you the goal and milestones, then starts on the first. A running `/goal` is cleared first.
  - `/goal-mode set <condition> [--check <command>]` sets the goal yourself, through `/goal`, which starts the work. It is refused in plan mode and while a loop runs.
  - `/goal-mode` shows the loop's current goal, or points to `/goal`.
  - `/goal-mode clear` removes it.
  - The model cannot clear or replace a goal.

## Loop mode (unattended)

`/goal-mode loop on` works through `<repo>/.claude/goals.md`, one goal per line:

```
- [ ] make add() return a + b :: check: source ~/dev/mlx_env/bin/activate && pytest -q
```

For each pending line the loop:

1. creates `worktrees/goal-NN-<slug>` on branch `goal/NN-<slug>`;
2. sends a kickoff prompt;
3. at every Stop, runs the line's `check` itself in the worktree (non-zero exit blocks with its output, no model call), refuses uncommitted changes, then asks this plugin's own evaluator: `claude-sonnet-5-5` judges the goal from the final message plus the transcript tail (real tool output only counts), and a transcript over the 4 MiB read cap is judged by a fork of the session instead;
4. on success marks the line `[x]` and starts the next one.

A line with `:: base: <branch>` starts from that branch and goes before the other pending lines, since it repairs work that later lines may build on.

When stuck (5 unmet checks in one turn, two unreadable verdicts, or the evaluator fails) it waits 2 minutes and sends a "change your approach" prompt, at most twice. After that the line is marked `[!]` and the loop moves on. The model may call `defer_goal` for an external blocker after 2 failed checks; the deferral is applied at the next Stop.

Each evaluator call takes about 2–20 s. It is billed to the session's credentials but does not appear in `/cost`, since plugin completions stay out of the session totals.

While a loop goal runs, the plugin refuses:

- AskUserQuestion and EnterPlanMode;
- edits inside the repository but outside the worktree;
- pushes other than an explicit `goal/*` branch, and force pushes;
- `git reset --hard`, `sudo`, deploy and cluster commands, and `rm -rf` outside the worktree;
- any regex listed in `.claude/goal-loop.deny`.

Other notes:

- Log: `.claude/goal-loop.log` (JSONL).
- Excluded from git automatically via `.git/info/exclude`: the queue, log, deny file and `worktrees/`.
- Branches are never merged automatically; review and merge them yourself.
- Drivers (auto-claude) steer the loop through two files. `.claude/goal-loop.base` names the ref new worktrees start from. `.claude/goal-loop.gate` holds a credit: the number of goals that may still start. Each start spends one, and at `0` the loop waits, still on. The credit does not depend on the loop's own goal count, which carries over between runs.
- `/goal-mode loop off|status|resume`: `resume` takes over a loop whose session went away. A resumed (`claude --continue`) owner session continues by itself.
- Only one session may run a repository's loop at a time: another session active in the last 10 minutes keeps it.

## Auto-declared goals (0.3.0)

The model is nudged to set its own goal at two points, with no extra model call.

- **When a plan is approved:** right after `ExitPlanMode` succeeds. This also fixes a bug where `set_goal` kept refusing with "plan mode" for the rest of the turn the plan was approved in.
- **On a typed prompt:** when the prompt asks for an outcome. That means a request verb such as 고쳐/구현/추가/통과/fix/implement/migrate, at least 30 characters, not a question, and not a slash command.

The nudge is a short context note. The model still decides, and skips it when the request has no verifiable end state. No nudge is sent in plan mode, while a loop runs, or on a Claude Code without `/goal`. The nudge cannot see a goal already in `/goal`, so it may come again after one is set. Turn it off with the `autoGoal` option.

