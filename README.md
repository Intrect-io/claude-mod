# claude-mod

Claude Code mods (plugins with a hooks module), served as a local folder marketplace.

| mod | version | what it does |
| --- | --- | --- |
| [goal-mode](goal-mode/) | 0.3.0 | Claude sets its own session goal (nudged on outcome requests and approved plans); an independent evaluator keeps it working at Stop until the goal is met |
| [harness](harness/) | 0.2.0 | The integrated harness: the user's Claude rules enforced at the tool call, session tooling and workflow automation (formerly house-rules) |
| [model-tier](model-tier/) | 0.1.0 | Routes each main-loop turn to opus, sonnet or haiku by task complexity, with a `set_tier` tool the model can call to correct itself |

## Install

```sh
claude plugin marketplace add /Users/unohee/dev/claude-mod
claude plugin install goal-mode@claude-mod
claude plugin install harness@claude-mod
claude plugin install model-tier@claude-mod
```

Installed plugins are read from this folder directly: after an edit, run
`/reload-plugins` in a session. No reinstall or version bump is needed.

## Develop

```sh
claude plugin validate <mod>
claude plugin test <mod>
```
