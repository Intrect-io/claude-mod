# claude-mod

Claude Code mods (plugins with a hooks module), served as a local folder marketplace.

| mod | version | what it does |
| --- | --- | --- |
| [goal-mode](goal-mode/) | 0.6.2 | Session goals, handed to Claude Code's own `/goal` where it exists (its own evaluator elsewhere): set by you (`/goal-mode set <condition> [--check <cmd>]`) or by Claude itself (nudged on outcome requests and approved plans) |
| [harness](harness/) | 0.2.2 | The integrated harness: the user's Claude rules enforced at the tool call, session tooling and workflow automation (formerly house-rules) |
| [auto-claude](auto-claude/) | 0.2.8 | Unattended run of a repository on top of goal-mode's loop: plans the long-term goal and milestones, ships each (push, PR, CI, merge when green), replans until the final check passes |
| [model-tier](model-tier/) | 0.5.1 | Routes each main-loop turn to fable, opus, sonnet or haiku and a reasoning effort by task complexity, with a `set_tier` tool the model calls to correct either |

## Install

```sh
claude plugin marketplace add Intrect-io/claude-mod
claude plugin install goal-mode@claude-mod
claude plugin install harness@claude-mod
claude plugin install model-tier@claude-mod
claude plugin install auto-claude@claude-mod   # needs goal-mode
```

For development, add a local clone instead (`claude plugin marketplace add /path/to/claude-mod`): installed plugins are then read from that folder directly, and after an edit `/reload-plugins` in a session picks it up. `scripts/reload-sessions.sh --apply [--host <ssh host>]` sends it to every idle session in tmux, here or on another machine. No reinstall or version bump is needed.

## Develop

```sh
claude plugin validate <mod>
claude plugin test <mod>
```

Files that several mods share live in `shared/`. A mod imports nothing outside its folder, so `bun scripts/sync-shared.ts` writes each mod's copy, and CI fails when a copy differs from `shared/`. Edit the file in `shared/`, never a copy. `shared/loop-protocol.jsonl` records the protocol between goal-mode's loop and auto-claude, gate values and log lines included. goal-mode's tests check that the loop writes it, and auto-claude's tests replay it, so a change on either side fails a test on the other.

`scripts/ci.sh` runs the whole gate that `.github/workflows/ci.yml` runs on every pull request and on main. It validates the marketplace and every mod, runs every mod's tests, and typechecks and tests fleet-hub. `claude plugin test` exits 0 even when a test fails, so the script reads the pass and fail counts instead.

```sh
bash scripts/ci.sh
```
