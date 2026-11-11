# claude-mod

Claude Code mods (plugins with a hooks module), served as a local folder marketplace.

| mod | version | what it does |
| --- | --- | --- |
| [harness](harness/) | 0.3.4 | The integrated harness: the user's Claude rules enforced at the tool call, session tooling and workflow automation (formerly house-rules) |
| [auto-claude](auto-claude/) | 1.1.0 | Unattended run of a repository through to live: plans the long-term goal, milestones and deploy; its own loop builds and judges each milestone in a worktree; ships each (push, PR, required CI, merge), deploys and smoke-checks it; a watchdog repairs or routes around stalls; replans until the final check passes. Absorbed goal-mode in 1.0.0; since 1.1.0 the session never rests: the next milestone is built, stacked, while a PR waits on CI |
| [model-tier](model-tier/) | 0.11.0 | Routes each main-loop turn to fable, opus, sonnet or haiku and a reasoning effort by task complexity, with a `set_tier` tool the model calls to correct either |
| [refactor](refactor/) | 0.1.3 | Enforces the architecture a repo declares in `.claude/architecture.json` at Edit/Write (layer direction, forbidden imports), notes code smells with the refactoring.guru technique to apply, `/arch audit` for violations and import cycles |

## Install

```sh
claude plugin marketplace add Intrect-io/claude-mod
claude plugin install harness@claude-mod
claude plugin install model-tier@claude-mod
claude plugin install auto-claude@claude-mod
claude plugin install refactor@claude-mod
```

For development, add a local clone instead (`claude plugin marketplace add /path/to/claude-mod`): installed plugins are then read from that folder directly, and after an edit `/reload-plugins` in a session picks it up. `scripts/reload-sessions.sh --apply [--host <ssh host>]` sends it to every idle session in tmux, here or on another machine, but never to the session running the script. No reinstall or version bump is needed. `scripts/deploy.sh` does the whole deploy: it fast-forwards the checkout here and on vela, updates every installed mod, and reloads idle sessions. auto-claude runs it after each merge in this repository (`.claude/auto-deploy.json`).

## Develop

```sh
claude plugin validate <mod>
claude plugin test <mod>
```

Files that several mods share live in `shared/`. A mod imports nothing outside its folder, so `bun scripts/sync-shared.ts` writes each mod's copy, and CI fails when a copy differs from `shared/`. Edit the file in `shared/`, never a copy. (goal-mode, whose loop auto-claude drove through a file protocol kept in `shared/loop-protocol.jsonl`, merged into auto-claude in 1.0.0; the loop and its driver now call each other directly.)

`scripts/ci.sh` runs the whole gate that `.github/workflows/ci.yml` runs on every pull request and on main. It validates the marketplace and every mod, runs every mod's tests, and typechecks and tests fleet-hub. `claude plugin test` exits 0 even when a test fails, so the script reads the pass and fail counts instead.

```sh
bash scripts/ci.sh
```
