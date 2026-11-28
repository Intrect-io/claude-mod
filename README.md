# claude-mod

Claude Code mods (plugins with a hooks module), served as a local folder marketplace.

| mod | version | what it does |
| --- | --- | --- |
| [harness](harness/) | 0.7.0 | The integrated harness: the user's Claude rules enforced at the tool call, session tooling and workflow automation (formerly house-rules) |
| [auto-claude](auto-claude/) | 1.19.1 | Unattended run of a repository through to live: plans the long-term goal, milestones and deploy; its own loop builds and judges each milestone in a worktree; ships each (push, PR, required CI, merge), deploys and smoke-checks it; a watchdog repairs or routes around stalls; replans until the final check passes. Absorbed goal-mode in 1.0.0; since 1.1.0 the session never rests: the next milestone is built, stacked, while a PR waits on CI; since 1.3.0 a line can wait on a training run or cache build (`:: after:`, `wait_until`) without ending the run; since 1.4.0 `--always-on` stands by after the final check and wakes for new cycles from Linear, the live smoke check, the default branch's CI and labelled GitHub issues; since 1.5.0 a run whose session went quiet is taken over by any free session of the repository; since 1.6.0 a finished run plans the next one toward the same aim by itself (within daily caps; `--once` opts out), only CodeQL results a run brings in block its deploys, and a wait on a removed milestone worktree goes to the model at once; since 1.7.0 the session that owns a run works in ultracode (standing dynamic workflows), and a milestone is judged only once the workflows its turn started have finished; since 1.11.0 `/auto-claude stats` shows where each run's time went, idle-quiet included; since 1.12.0 a diff judge holds a milestone whose diff circumvents its check (changed tests or test infrastructure, re-run on the base tests), measured on pinned fixtures by `auto-claude/eval/judge-eval.ts` since 1.13.0; since 1.14.0 `defer_goal` is open from the first check, with a category (spec-ambiguous for a spec its check contradicts); since 1.15.0 a PR touching a protected path (`.claude/protected.json` on the default branch, plus the CI and run files) waits for a person to merge it; since 1.16.0 issues delegated to the Linear app become milestones, and their agent sessions get the plan, activities and the PR, through the linear-agent Worker (`~/.claude/linear-agent.json`); since 1.17.0 a delegated issue with several milestones is split into delegated sub-issues, unclear milestones are asked in the session, and held milestones and a red default branch become Triage issues (never twice, `maxIssuesPerDay`); since 1.17.2 each run logs and tells once whether the bridge is on, and why not (`agent-bridge`, `/auto-claude status`); since 1.17.3 a delegated plan is split into sub-issues when it is accepted, before its first milestone starts; since 1.17.4 an issue several lines name moves to Done only when the last of them lands, and an issue owned by the app gets no merge comment under the person's name; since 1.18.0 `/auto-claude start` while a run is on replaces it with the new aim, `/auto-claude approve [pr]` lets a PR held for protected files land at the head the person saw, the owning session is told what waits on the person, and a Stop with a background `git commit` still running is not judged; since 1.19.0 the status line piece says whether the run is working, waiting on what it watches, or stalled, and since when (red for what needs a look, including a hung driver); since 1.19.1 the Linear app's own activity comments and Linear's session root comment are not counted as changes, so a deferral no longer queues a follow-up by itself |
| [model-tier](model-tier/) | 0.12.0 | Routes each main-loop turn to fable, opus, sonnet or haiku and a reasoning effort by task complexity, with a `set_tier` tool the model calls to correct either |
| [refactor](refactor/) | 0.1.3 | Enforces the architecture a repo declares in `.claude/architecture.json` at Edit/Write (layer direction, forbidden imports), notes code smells with the refactoring.guru technique to apply, `/arch audit` for violations and import cycles |

[linear-agent](linear-agent/) (0.2.1) is not a mod. It is the Cloudflare Worker behind auto-claude's Linear agent app, under its own app identity:

- it verifies Linear's webhooks and queues agent session events in D1;
- it holds the app's OAuth token;
- it gives auto-claude's driver a small session API for activities, plans, links and issues.

It is shipped by hand, never by a run. To deploy it and install the app (an install link from `POST /v1/install`), follow [Ship (by hand)](linear-agent/README.md#ship-by-hand) in its README.

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

`scripts/ci.sh` runs the whole gate that `.github/workflows/ci.yml` runs on every pull request and on main. It validates the marketplace and every mod, runs every mod's tests, and typechecks each mod that has a tsconfig.json. It also runs linear-agent's `bun test` and type check. `claude plugin test` exits 0 even when a test fails, so the script reads the pass and fail counts instead.

```sh
bash scripts/ci.sh
```
