# claude-mod: improvements

Findings from building and running goal-mode, harness and model-tier (fleet and fleet-hub were removed on 2026-10-29: auto-claude covers unattended runs, and their items went with them) across the Mac and vela on 2026-10-26/27. Every item names its evidence: a `file:line` in this repository, or something measured in that session. Each item also names a concrete fix.

P0: a security hole or lost work; fix before anything else.
P1: wrong behaviour, or something the person has to work around.
P2: cost, upkeep or polish.

---

## P0

### goal-mode: a goal handed off mid-turn could be lost

- **Evidence.**
  - Measured in session a5d6cd33: `set_goal` answered "Goal handed to Claude Code's /goal", but no `/goal` ever ran. The transcript holds only the `/goal clear` that `auto` queued.
  - The first attempt was lost to an interrupt (Esc), which drops a queued command.
  - The second was lost with no interrupt. The cause is not established, because that session had no `--debug`.
  - The cause is the hand-off being a timer started inside the tool call (`goal-mode/hooks/register.tsx:178` `runNativeLater`). This build has no `ProposeGoal`; the debug log says `no tool named "ProposeGoal"`.
- **Fix (done in the working tree, not yet committed).**
  - The hand-off is recorded (`pendingNative`) and runs from the `classic.Stop` hook. When an interrupt skipped the stop, it runs at the next main `turn.start`.
  - `proposeNow` (`goal-mode/hooks/register.tsx:188`) sets the goal at once wherever `ProposeGoal` exists.
  - Measured in a debug probe: after `set_goal` and three more tool calls, `/goal … → Goal set` ran as the turn stopped.
  - **Remaining:** commit it, deploy it (Mac and vela), and reload.

---

## P1

### goal-mode: the plugin's own evaluator path is now mostly dead code that still has to be kept

- **Evidence.**
  - With `/goal` present, `useNative` sends every goal there (`goal-mode/hooks/register.tsx:336`). Only the loop's queue goals still reach `evaluate` (`goal-mode/hooks/register.tsx:1082`).
  - The pause rules, the intent check and refine-once (0.4.0) apply only where `/goal` is absent.
- **Fix.**
  - Decide which path is primary.
  - If it is `/goal`, either fold refine-once into the auto kickoff and drop `intent`, or port the intent wording into the `/goal` condition text.
  - Keep `evaluate` for the loop only, and say so in the README.

### all mods: a notice row from an earlier version outlives a reload

- **Evidence.** It happened twice this session. `⚠ model-tier: tier: opus (auto)` stayed after 0.2 stopped using `$.ui.status`, and `⚠ fleet: hub offline` stayed on vela because counted failures skipped the redraw. Fixed one at a time, in `model-tier/hooks/register.ts` (`show` clears the row) and `fleet/hooks/register.ts` (`showStatus` once at start).
- **Fix.**
  - Every mod calls its `showStatus` unconditionally in `session.start`: `goal-mode/hooks/register.tsx:1326`, `harness/hooks/register.ts:44`, model-tier `show`.
  - A test per mod asserts that the first `ui.status` after start is the normal-state value, which is `undefined` when nothing needs attention.

### statusline pieces: never cleared, never collected

- **Evidence.** `*/hooks/segment.ts` (`let last` at line 10) writes `~/.claude/statusline/<session>/<mod>.txt`. Nothing clears it at `session.end` (`fleet/hooks/register.ts:309` ends without `segment($, '')`). Measured: 12 session folders already, most for sessions that have ended.
- **Fix.**
  - `segment($, '')` in each mod's `session.end`.
  - A weekly sweep in the hub (or `memory-gc-scan.py`) that moves folders older than 7 days to `~/.claude/trash/`, because the house rule forbids `rm`.

### segment helper copied into four mods

- **Evidence.** `goal-mode/`, `harness/`, `model-tier/` and `auto-claude/` each hold their own `hooks/segment.ts`. Four md5s, differing only in `MOD`.
- **Fix.** Keep the copies (a mod imports nothing outside its folder), but generate them: `scripts/sync-shared.ts` writes `segment.ts` (and the grant verdict above) from `shared/`, and CI fails when a copy drifts.

### model-tier: two classifier calls per prompt

- **Evidence.**
  - `model-tier/hooks/register.ts:277` runs `classify` and `classifyEffort` in parallel on every prompt. Measured: 0.9–1.9 s each on haiku, and the slower one gates the prompt.
  - With `classifierTimeoutMs` 3000 (`model-tier/hooks/register.ts:197`), a timeout keeps the old tier. Measured once: a design prompt stayed `haiku·low` after a trivial one.
- **Fix.**
  - Make one call with a combined label set (`complex/tricky-problem`, …): one round trip, one timeout.
  - Or run effort only when the tier verdict is `complex` or above.
  - Log timeouts to `~/.claude/model-tier.log` so the 3 s bound can be tuned from data.

### model-tier: label names steer the classifier; nothing checks a rename

- **Evidence.** `model-tier/hooks/register.ts:26`. Measured: the label `quick-answer` sent a hard design question ("세 줄 이내로") to `low`. The renamed `tricky-problem` labels sent it to `high`. And `exceptionally-hard` routed a novel BFT-protocol design prompt to fable, which answered after 8 min 7 s.
- **Fix.** Add a small eval: 20 labelled prompts in `model-tier/eval/prompts.jsonl`, run by `claude plugin eval` (or `bun model-tier/eval/run.ts`) against haiku. Fail when tier or effort accuracy drops below the last run, so a label rename is measured before it ships.

