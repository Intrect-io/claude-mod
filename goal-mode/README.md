# goal-mode

Lets Claude set its own session goal, then keeps it working until an independent evaluator confirms the goal is met.

- **Setter**: the model calls `mcp__goal-mode__set_goal` with one measurable end state (and optionally its check) when the user asked for a verifiable, multi-turn outcome. No approval prompt; the model reports the goal in one line. Refused in plan mode, when a goal is already set, or when Claude Code's native `ProposeGoal` tool is available (the model is told to use that instead).
- **Evaluator**: at every main-thread Stop, `claude-sonnet-5-5` judges the goal from the final message plus the transcript tail (real tool output only counts). Unmet blocks the stop with the reason. A transcript over the 4 MiB read cap is judged by a fork of the session instead.
- **Pauses** (stop is allowed, a typed message resumes): evaluator failure, two unreadable verdicts, 5 unmet checks in one turn, or 30 checks in total.
- **User command**: `/goal-mode` shows the goal; `/goal-mode clear` removes it. The model cannot clear its own goal.

Known limitation: if the native `/goal` is also set by hand, both evaluators run.

Cost and latency: while a goal is active, every Stop makes one evaluator call (about 2–20 s observed). That call is billed to the session's credentials but does not appear in `/cost`, since plugin completions stay out of the session totals. When no goal is set, the Stop hook makes no model call.

## Loop mode (unattended)

`/goal-mode loop on` works through `<repo>/.claude/goals.md`, one goal per line:

```
- [ ] make add() return a + b :: check: source ~/dev/mlx_env/bin/activate && pytest -q
```

For each pending line the loop:

1. creates `worktrees/goal-NN-<slug>` on branch `goal/NN-<slug>`;
2. sends a kickoff prompt;
3. at every Stop, runs the line's `check` itself in the worktree (non-zero exit blocks with its output, no model call), refuses uncommitted changes, then asks the evaluator;
4. on success marks the line `[x]` and starts the next one.

When stuck (5 unmet checks in a row, or the evaluator fails) it waits 2 minutes and sends a "change your approach" prompt, at most twice. After that the line is marked `[!]` and the loop moves on. The model may call `defer_goal` for an external blocker after 2 failed checks; the deferral is applied at the next Stop.

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
- `/goal-mode loop off|status|resume`: `resume` takes over a loop whose session went away. A resumed (`claude --continue`) owner session continues by itself.
- Only one session may run a repository's loop at a time: another session active in the last 10 minutes keeps it.
