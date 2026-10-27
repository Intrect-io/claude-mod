# claude-mod: improvements

Findings from building and running fleet, fleet-hub, goal-mode, harness and model-tier across the Mac and vela on 2026-10-26/27. Every item names its evidence: a `file:line` in this repository, or something measured in that session. Each item also names a concrete fix.

P0: a security hole or lost work; fix before anything else.
P1: wrong behaviour, or something the person has to work around.
P2: cost, upkeep or polish.

---

## P0

### fleet-hub: any of the person's tailnet machines passes as the person, including vela, where agents run

- **Evidence.** `fleet-hub/src/net.ts:82` (`isOwnerPeer`) and `fleet-hub/src/http.ts:144` (`authed`) let in, without the dashboard token, any device that `tailscale whois` reports as the same user. vela is such a device, and Claude sessions run on it. Measured: from vela, `curl -X POST http://100.123.244.103:4848/api/human/post` with no token returned **HTTP 200**, and the message was stored as `from.kind = "human"`. With that, a session on vela can post as the person, talk to the orchestrator (`/api/orchestrator`), or write the §6.5 grant (`POST /api/grant`), which would widen what every session accepts from the orchestrator.
- **Fix.**
  - Trust only an explicit list for tokenless access: `FLEET_TRUSTED_DEVICES=iphone181,heewons-macbook-air`, matched against the `whois` node name, never "any device of this user".
  - Keep `/api/grant` (POST and DELETE) and `/api/grant/requests/*/approve` token-only on every door. A person's phone gets the token once through the URL fragment.
  - Add a test that a peer IP outside the list gets 401 for `/api/human/post` and `/api/grant`.
  - Until then, run the hub with `FLEET_TAILSCALE=0`.

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

### fleet-hub: the hub lives and dies with one Claude session

- **Evidence.**
  - Every hub run this session was a background task of session a5d6cd33 (`bun src/main.ts` via `run_in_background`). Closing that session kills the dashboard, the orchestrator and every session's channels.
  - One restart also failed with `Module not found "src/main.ts"` because of a relative entry path.
- **Fix.**
  - Ship `fleet-hub/launchd/com.unohee.fleet-hub.plist` running the absolute entry path, with `KeepAlive` and logs in `~/.claude/fleet/`.
  - Add `bun run install-agent`, which writes the plist after a confirmation.
  - The plan already lists this (PLAN.md Phase 2, "기동").

### fleet-hub: every hub restart re-sends the grant mandate to a fresh orchestrator

- **Evidence.**
  - `fleet-hub/src/main.ts:105` calls `orchestrator.granted(status.grant, 'restart')` on every start.
  - `fleet-hub/src/orchestrator.ts:331` resumes only by an in-memory `sessionId`, so each restart is a new agent with no memory of what it already asked.
  - So every restart (this session restarted the hub eight-plus times) hands the same mandate to an agent that cannot know it already acted on it. Re-dispatch after a restart was not separately observed.
- **Fix.**
  - Persist the SDK session id in `~/.claude/fleet/orchestrator.json` and pass `resume`.
  - Store the grant's `issued_at` with the last mandate, and re-send only when it changed.

### fleet: sessions on vela cannot join the dashboard

- **Evidence.**
  - The mod's only transport is the Unix socket (`fleet/hooks/register.ts`, `socketPath`). vela's five sessions show `fleet○` and never reach `/api/sessions`.
  - The tailnet door cannot carry them, because it is the person's door. See the P0 above.
- **Fix.**
  - Add a third door for remote sessions on the tailnet. It needs a per-machine session key that the person issues once (`~/.claude/fleet/session-key`, 0600), and it may speak only as a session: the UDS routes, never `/api/human/*`, the orchestrator or the grant.
  - The mod gains a `hubUrl` option (`http://100.123.244.103:4848`) and a key path.

### fleet: reloading every session needs a throwaway script

- **Evidence.**
  - "Reload all sessions" ran through `/private/tmp/claude-501/reload-sessions.py`, copied to vela's `/tmp`. Measured: vela's copy was gone at the next deploy (`can't open file '/tmp/reload-sessions.py'`).
  - What it knows matters and lives only there:
    - skip `waiting`, since a key would answer an open question;
    - skip a non-empty draft, while treating a dim suggestion as empty;
    - queue into busy sessions, which runs after the turn (measured).
- **Fix.** Make it a hub action:
  - `POST /api/sessions/reload` and a dashboard button, plus `/fleet reload-all`.
  - The rules above, as tested pure functions.
  - The registry's `tmux` field gives the pane.

### goal-mode: the plugin's own evaluator path is now mostly dead code that still has to be kept

- **Evidence.**
  - With `/goal` present, `useNative` sends every goal there (`goal-mode/hooks/register.tsx:336`). Only the loop's queue goals still reach `evaluate` (`goal-mode/hooks/register.tsx:1082`).
  - The pause rules, the intent check and refine-once (0.4.0) apply only where `/goal` is absent.
- **Fix.**
  - Decide which path is primary.
  - If it is `/goal`, either fold refine-once into the auto kickoff and drop `intent`, or port the intent wording into the `/goal` condition text.
  - Keep `evaluate` for the loop only, and say so in the README.

### harness and fleet: the §6.5 grant verdict is written twice

- **Evidence.** `harness/hooks/grant.ts:25` (`grantVerdict`, for native peer messages) and `fleet/hooks/wire.ts:69` (`verdict`, for hub messages) carry the same rules and wording. A change to one, for example a new grant field, silently diverges from the other.
- **Fix.**
  - Move the rule into one file that both mods import a copy of, enforced by a test that diffs the two copies (`harness/hooks/grant.test.ts` reading `../../fleet/hooks/wire.ts` is not allowed).
  - Alternatively, have only harness judge: fleet stamps `<fleet-message from-name=…>`, and harness's `session.receive` / prompt hook judges both formats.

---

## P2

### all mods: a notice row from an earlier version outlives a reload

- **Evidence.** It happened twice this session. `⚠ model-tier: tier: opus (auto)` stayed after 0.2 stopped using `$.ui.status`, and `⚠ fleet: hub offline` stayed on vela because counted failures skipped the redraw. Fixed one at a time, in `model-tier/hooks/register.ts` (`show` clears the row) and `fleet/hooks/register.ts` (`showStatus` once at start).
- **Fix.**
  - Every mod calls its `showStatus` unconditionally in `session.start`: `fleet/hooks/register.ts:94`, `goal-mode/hooks/register.tsx:1326`, `harness/hooks/register.ts:44`, model-tier `show`.
  - A test per mod asserts that the first `ui.status` after start is the normal-state value, which is `undefined` when nothing needs attention.

### statusline pieces: never cleared, never collected

- **Evidence.** `*/hooks/segment.ts` (`let last` at line 10) writes `~/.claude/statusline/<session>/<mod>.txt`. Nothing clears it at `session.end` (`fleet/hooks/register.ts:309` ends without `segment($, '')`). Measured: 12 session folders already, most for sessions that have ended.
- **Fix.**
  - `segment($, '')` in each mod's `session.end`.
  - A weekly sweep in the hub (or `memory-gc-scan.py`) that moves folders older than 7 days to `~/.claude/trash/`, because the house rule forbids `rm`.

### segment helper copied into four mods

- **Evidence.** `fleet/`, `goal-mode/`, `harness/`, `model-tier/` each hold their own `hooks/segment.ts`. Four md5s, differing only in `MOD`.
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

### fleet: the heartbeat spawns `git` every 30 s in every session

- **Evidence.** `fleet/hooks/register.ts:192` says hello every `HEARTBEAT_MS` (30 s, `fleet/hooks/wire.ts:12`), and each hello runs `git rev-parse --abbrev-ref HEAD` (`fleet/hooks/register.ts:119`). That is 9 sessions × 2 processes a minute for a branch that rarely changes.
- **Fix.**
  - The heartbeat posts `state` only.
  - The branch is read at `session.start` and `turn.complete`, and sent when it changed.

### fleet: delivery is at most once, so a failed submit drops the message

- **Evidence.** `fleet/hooks/register.ts:160` acks the inbox before `$.prompt.submit`. A submit that rejects only logs to debug.
- **Fix.** On a submit rejection, re-post the same text to the session's own DM (or `POST /api/inbox/:id/nack`), so the next poll delivers it, with a retry cap of 3.

### fleet tests do not cover the inbox → prompt path

- **Evidence.**
  - `fleet/hooks/fleet.test.ts` has 10 tests: wire helpers, hello, `fleet_post` and the token deny. `grep inbox|poll` finds none.
  - The path was only exercised live, through the two PONG round trips.
- **Fix.** Add a test with `mock.clock`. The inbox answers one orchestrator DM, and the test asserts:
  - an ack is sent;
  - one `prompt.submit` carries the `[fleet grant check]` verdict and the `<fleet-message>` frame;
  - a second poll submits nothing.

### fleet-hub: dead sessions accumulate in the registry

- **Evidence.** `fleet-hub/src/bus.ts:131` prunes messages after 90 days but never sessions. Measured: `fleet_who` listed 8 offline probe or ended sessions beside the live ones.
- **Fix.** Delete `offline` sessions not seen for 24 h in `sweep()`, keeping their messages. Have the dashboard hide `offline` by default.

### fleet-hub: Slack was never exercised

- **Evidence.**
  - `fleet-hub/src/slack.ts` is unit-tested for the user filter only.
  - Measured: `slack: off — no token in keychain (vega-slack-bot, vega-slack-app)` on every start, because the bot and app-level tokens were never issued.
- **Fix.**
  - Once the tokens exist, run a round trip in a test workspace or a private channel: a mention reaches the orchestrator, `slack_post` arrives, and a grant button is approved by an allowed user and refused for another.
  - Record it in PLAN.md.

### fleet: the dashboard-token guard matches one spelling

- **Evidence.** `fleet/hooks/register.ts:230` denies only a `Bash` command or `Read` path containing the literal `fleet/dashboard-token`. Variants walk past it: a glob, `$HOME/.claude/fleet/dash*`, `cd ~/.claude/fleet && cat dashboard-token`.
- **Fix.**
  - Best effort as it stands: also match `dashboard-token` alone and `Grep` / `Glob` on `~/.claude/fleet`.
  - The real fix is the P0 above: the token no longer grants the grant routes from a second machine. On the Mac itself, sessions run as the same user, so a file guard is never a boundary. Say so in `fleet/README.md`.

---

## Measured baseline (for the next pass)

| mod | source lines | tests |
| --- | --- | --- |
| fleet | 548 | 10 |
| goal-mode | 2000 | 69 |
| harness | 2269 | 116 |
| model-tier | 635 | 24 |
| fleet-hub | 1383 | 26 |

The test counts are from the last run of `claude plugin test <mod>` and of `bun test` in `fleet-hub`.
