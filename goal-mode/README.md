# goal-mode

Lets Claude set its own session goal, then keeps it working until an independent evaluator confirms the goal is met.

- **Setter**: the model calls `mcp__goal-mode__set_goal` with one measurable end state (and optionally its check) when the user asked for a verifiable, multi-turn outcome. No approval prompt; the model reports the goal in one line. Refused in plan mode, when a goal is already set, or when Claude Code's native `ProposeGoal` tool is available (the model is told to use that instead).
- **Evaluator**: at every main-thread Stop, `claude-sonnet-5-5` judges the goal from the final message plus the transcript tail (real tool output only counts). Unmet blocks the stop with the reason. A transcript over the 4 MiB read cap is judged by a fork of the session instead.
- **Pauses** (stop is allowed, a typed message resumes): evaluator failure, two unreadable verdicts, 5 unmet checks in one turn, or 30 checks in total.
- **User commands**:
  - `/goal-mode auto [hint]` (or a bare `/goal-mode set`) hands the choice to Claude. Claude reads the situation (this conversation, any approved plan, the repository state, unfinished or blocked work) and picks the one next outcome that fits it, as one measurable end state. It sets that goal itself without asking you to choose, tells you in one line and starts. An existing goal is cleared first and passed along as context. The optional hint steers the choice (`/goal-mode auto 배포 마무리 위주로`).
  - `/goal-mode set <condition> [--check <command>]` sets the goal yourself. No nudge or model judgement is involved, and an existing goal is replaced. Claude starts on it at once (a kickoff prompt) and the same evaluator judges every stop. It is refused in plan mode and while a loop runs.
  - The text may name a direction instead of an end state, e.g. `/goal-mode set 새로 추진할 목표를 정해봐`. Claude then turns it into one measurable end state (asking you when the choice is yours) and refines the goal with `set_goal`, **once**.
    - Your words stay beside the refined goal (`Your words:` in `/goal-mode`).
    - The evaluator judges the refined goal against those words too, so a refinement that dodges them is not met.
    - A second change is refused.
  - `/goal-mode` shows the goal.
  - `/goal-mode clear` removes it.
  - The model cannot clear or replace a goal.

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

## Auto-declared goals (0.3.0)

The model is nudged to set its own goal at two points, with no extra model call.

- **When a plan is approved:** right after `ExitPlanMode` succeeds. This also fixes a bug where `set_goal` kept refusing with "plan mode" for the rest of the turn the plan was approved in.
- **On a typed prompt:** when the prompt asks for an outcome. That means a request verb such as 고쳐/구현/추가/통과/fix/implement/migrate, at least 30 characters, not a question, and not a slash command.

The nudge is a short context note. The model still decides, and skips it when the request has no verifiable end state. No nudge is sent when a goal is already set, in plan mode, or while a loop runs. Turn it off with the `autoGoal` option.

