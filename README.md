# claude-mod

Claude Code mods (plugins with a hooks module), served as a local folder marketplace.

| mod | version | what it does |
| --- | --- | --- |
| [goal-mode](goal-mode/) | 0.5.0 | Session goals, handed to Claude Code's own `/goal` where it exists (its own evaluator elsewhere): set by you (`/goal-mode set <condition> [--check <cmd>]`) or by Claude itself (nudged on outcome requests and approved plans) |
| [harness](harness/) | 0.2.0 | The integrated harness: the user's Claude rules enforced at the tool call, session tooling and workflow automation (formerly house-rules) |
| [auto-claude](auto-claude/) | 0.1.0 | Unattended run of a repository on top of goal-mode's loop: plans the long-term goal and milestones, ships each (push, PR, CI, merge when green), replans until the final check passes |
| [fleet](fleet/) | 0.1.0 | Links the session to [fleet-hub](fleet-hub/) (a local Bun daemon with a web dashboard, an Agent SDK orchestrator and Slack): IRC-style channels between sessions, state telemetry, orchestrator messages with a §6.5 grant verdict |
| [model-tier](model-tier/) | 0.3.0 | Routes each main-loop turn to fable, opus, sonnet or haiku and a reasoning effort by task complexity, with a `set_tier` tool the model calls to correct either |

## Install

```sh
claude plugin marketplace add Intrect-io/claude-mod
claude plugin install goal-mode@claude-mod
claude plugin install harness@claude-mod
claude plugin install model-tier@claude-mod
claude plugin install auto-claude@claude-mod   # needs goal-mode
claude plugin install fleet@claude-mod   # then run the hub: cd fleet-hub && bun install && bun src/main.ts
```

For development, add a local clone instead (`claude plugin marketplace add /path/to/claude-mod`): installed plugins are then read from that folder directly, and after an edit `/reload-plugins` in a session picks it up. No reinstall or version bump is needed.

## Develop

```sh
claude plugin validate <mod>
claude plugin test <mod>
```

`scripts/ci.sh` runs the whole gate that `.github/workflows/ci.yml` runs on every pull request and on main. It validates the marketplace and every mod, runs every mod's tests, and typechecks and tests fleet-hub. `claude plugin test` exits 0 even when a test fails, so the script reads the pass and fail counts instead.

```sh
bash scripts/ci.sh
```
