# claude-mod: improvements

Findings from building and running goal-mode, harness and model-tier (fleet and fleet-hub were removed on 2026-10-29: auto-claude covers unattended runs, and their items went with them) across the Mac and vela on 2026-10-26/27. Every item names its evidence: a `file:line` in this repository, or something measured in that session. Each item also names a concrete fix.

P0: a security hole or lost work; fix before anything else.
P1: wrong behaviour, or something the person has to work around.
P2: cost, upkeep or polish.

---

## P0

### goal-mode: a goal handed off mid-turn could be lost

- **Status:** resolved in be954dd ("hand a mid-turn goal to /goal at the stop, not on a timer"), guarded by the test "set_goal hands the goal to /goal as the turn ends; no evaluator of its own runs", and deployed to the Mac and vela with goal-mode 0.6.0 on 2026-10-29.
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

- **Status:** resolved in #20 (goal-mode 0.7.0). `/goal` is the only session-goal path, the `nativeGoal` option and the fallback evaluator are gone, and `evaluate` judges only the loop's queued goals.

- **Evidence.**
  - With `/goal` present, `useNative` sends every goal there (`goal-mode/hooks/register.tsx:336`). Only the loop's queue goals still reach `evaluate` (`goal-mode/hooks/register.tsx:1082`).
  - The pause rules, the intent check and refine-once (0.4.0) apply only where `/goal` is absent.
- **Fix.**
  - Decide which path is primary.
  - If it is `/goal`, either fold refine-once into the auto kickoff and drop `intent`, or port the intent wording into the `/goal` condition text.
  - Keep `evaluate` for the loop only, and say so in the README.

### all mods: a notice row from an earlier version outlives a reload

- **Status:** resolved: every mod draws its normal notice row and piece in `session.start` with nothing in the way. auto-claude now also draws when there is no run, and model-tier awaits its draw. Each mod has a test named "session.start draws … session.end clears …" that asserts the first `ui.status` is the normal value (`undefined`) or that a stale piece is taken down.
- **Evidence.** It happened twice this session. `⚠ model-tier: tier: opus (auto)` stayed after 0.2 stopped using `$.ui.status`, and `⚠ fleet: hub offline` stayed on vela because counted failures skipped the redraw. Fixed one at a time, in `model-tier/hooks/register.ts` (`show` clears the row) and `fleet/hooks/register.ts` (`showStatus` once at start).
- **Fix.**
  - Every mod calls its `showStatus` unconditionally in `session.start`: `goal-mode/hooks/register.tsx:1326`, `harness/hooks/register.ts:44`, model-tier `show`.
  - A test per mod asserts that the first `ui.status` after start is the normal-state value, which is `undefined` when nothing needs attention.

### statusline pieces: never cleared, never collected

- **Status (2026-11-01):** the sweep landed in harness 0.3.2 (#19). Once a day it moves stale folders to `~/.claude/trash/statusline/`: all-empty ones after 1 day, ones that still hold text after 14 days.

- **Status:** resolved for new pieces: each mod clears its status line piece at `session.end`, by the ending session's id, so `/clear` cannot orphan it. The same "session.end" test in each mod proves it. Not done: sweeping folders left by older sessions. The hub that was to run it is gone (see the plan's decisions).
- **Evidence.** `*/hooks/segment.ts` (`let last` at line 10) writes `~/.claude/statusline/<session>/<mod>.txt`. Nothing clears it at `session.end` (`fleet/hooks/register.ts:309` ends without `segment($, '')`). Measured: 12 session folders already, most for sessions that have ended.
- **Fix.**
  - `segment($, '')` in each mod's `session.end`.
  - A weekly sweep in the hub (or `memory-gc-scan.py`) that moves folders older than 7 days to `~/.claude/trash/`, because the house rule forbids `rm`.

### segment helper copied into four mods

- **Status:** resolved by `scripts/sync-shared.ts`: `shared/segment.ts` (with `MOD` filled in) and `shared/queue.ts` generate each mod's copy, and `bash scripts/ci.sh` fails on drift (`sync-shared --check`). The queue grammar was the dangerous copy. auto-claude's hand copy had already drifted: it dropped the notes that goal-mode's parser keeps.
- **Evidence.** `goal-mode/`, `harness/`, `model-tier/` and `auto-claude/` each hold their own `hooks/segment.ts`. Four md5s, differing only in `MOD`.
- **Fix.** Keep the copies (a mod imports nothing outside its folder), but generate them: `scripts/sync-shared.ts` writes `segment.ts` (and the grant verdict above) from `shared/`, and CI fails when a copy drifts.

### model-tier: two classifier calls per prompt

- **Status:** resolved in #22 (model-tier 0.6.0), by a different fix than proposed below. A probe showed one combined call is slower (p50 1881 ms against 1455 ms), and the eval found whole sessions at about 21 s per call. So a late label now decides the rest of the turn, and a slow classifier stops holding prompts. `classifier-late` log lines record the real latency for tuning.

- **Evidence.**
  - `model-tier/hooks/register.ts:277` runs `classify` and `classifyEffort` in parallel on every prompt. Measured: 0.9–1.9 s each on haiku, and the slower one gates the prompt.
  - With `classifierTimeoutMs` 3000 (`model-tier/hooks/register.ts:197`), a timeout keeps the old tier. Measured once: a design prompt stayed `haiku·low` after a trivial one.
- **Fix.**
  - Make one call with a combined label set (`complex/tricky-problem`, …): one round trip, one timeout.
  - Or run effort only when the tier verdict is `complex` or above.
  - Log timeouts to `~/.claude/model-tier.log` so the 3 s bound can be tuned from data.

### model-tier: label names steer the classifier; nothing checks a rename

- **Status:** resolved in #21. `/tier eval` runs the production `labelPrompt` over `model-tier/eval/prompts.jsonl`, and `baseline.json` holds 4 runs. Open: effort is wrong in a systematic way on mechanical edits (5 of 9 `low` prompts come back `medium`), and the README gate number (effort 0.583) is tighter than the measured spread (0.125).

- **Evidence.** `model-tier/hooks/register.ts:26`. Measured: the label `quick-answer` sent a hard design question ("세 줄 이내로") to `low`. The renamed `tricky-problem` labels sent it to `high`. And `exceptionally-hard` routed a novel BFT-protocol design prompt to fable, which answered after 8 min 7 s.
- **Fix.** Add a small eval: 20 labelled prompts in `model-tier/eval/prompts.jsonl`, run by `claude plugin eval` (or `bun model-tier/eval/run.ts`) against haiku. Fail when tier or effort accuracy drops below the last run, so a label rename is measured before it ships.

### model-tier: routing saved 1.6%; the classifier answers in ~21 s

- **Status (2026-11-03):** partly fixed in model-tier 0.7.0. The tier classifier is skipped when no verdict could change the tier (`canTierChange`). Open: the latency fix belongs in CC-Router (below).
- **Status (2026-11-04):** CC-Router's short-request bypass is deployed (unohee/CC-Router #20). The one-hour live test after it measured 336 classifications at p50 1151 ms / p90 2447 ms, with 0 over 15 s (`testing/live_classifier_261103_v1/`). model-tier 0.8.0 adds `/tier stats` for this day-to-day check, in place of the transcript scripts. The mod's log now has a line for every classified prompt, routed spawn, main-loop model switch and finished turn.
- **Evidence.** Measured over 14 days of transcripts (`testing/tier_effect_261103_v1.py`, `testing/billing_mix_261103_v1.py`).
  - Main loop: 87.6% of 54,323 requests ran on opus. Only 37 of 351 sessions used more than one model. Against an all-opus counterfactual, routing saved 1.6%.
  - Most turns cannot step down: the average context is ~400k tokens against `maxTokensForDowngrade` 200k. That ceiling is right. A switch rewrites the whole prefix, at 2x with the 1h cache TTL now on. Do not raise it.
  - `~/.claude/model-tier.log`, last 400 lines: 269 `classifier-late` and 131 `classifier-timeout`, p50 21.5 s and p90 22.2 s. The tight cluster is a wait, not model latency.
  - CC-Router on ubuntu-mini has its throttle on (`~/.cc-router/config.json`: 4 in flight per account, 250 ms spacing). `src/proxy/throttle.ts` waits up to `maxWaitMs` 20000, then lets the request through (fail-open).
  - The slow classifier also defeats subagent routing. Subagents cost ~$2.7k, and general-purpose was half of it: 76% of its requests ran on opus, because a timed-out spawn keeps the parent's model.
- **Fix.**
  - Done: `canTierChange` in `model-tier/hooks/register.ts` (pinned, or at `maxAutoTier` past the ceiling: classify effort only).
  - Open, CC-Router: let short, non-streaming, tool-less requests (the classifier's) skip the throttle wait or go to the front, and log each throttle wait. Then re-run `/tier eval` and the two scripts.

### Tried and dropped: a haiku digest of large Bash output (2026-11-03)

- **Idea.** A large Bash result goes to haiku first, and opus gets only the relevant lines, verbatim, plus a spill file holding the full output.
- **Why dropped.** It failed its gate in an offline replay of 100 real large results (`testing/digest_replay_261103_v1/`).
  - RULES v1: coverage 0.78 of the identifiers that the next action used, compression 0.55.
  - RULES v2, more conservative: coverage 0.99, but compression 0.98, because 93 of the 100 came back `NEED_FULL`.
  - Research agrees: compressing tool output as it arrives raised billed cost by 6.8% in a Claude Code study (arXiv 2607.12161).
- **What mattered instead.** Tool-output size is not a proxy for cost. 49% of main/opus spend was cache writes, and 88% of those came from 5-minute TTL expiry after idle gaps. `ENABLE_PROMPT_CACHING_1H=1` is now set on the Mac and vela.
- **Where the code is.** In `trash/digest_261103/`, with the replay in `testing/digest_replay_261103_v1/`. Its `digest-lib.ts` holds the v2 RULES.
