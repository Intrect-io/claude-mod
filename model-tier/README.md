# model-tier

A Claude Code mod that routes each main-loop turn to **opus**, **sonnet** or **haiku**
by task complexity, and lets the model correct the choice itself. **fable** is reached
only by `/tier fable` unless `maxAutoTier` allows it.

## How it works

- **Classifier (on prompt submit).** `$.model.classify` labels the prompt
  `trivial` / `standard` / `complex` / `exceptionally-hard` on a cheap model
  (haiku by default), mapped to haiku / sonnet / opus / fable (`claude-fable-5-1`).
  - Fable is the top tier, for novel research, deep design across many systems, or work where opus already failed.
  - Its label is named as a rare case on purpose, because fable is the scarcest and most rate-limited model.
  - `maxAutoTier` (default `opus`) caps what the classifier, subagent routing and `set_tier` pick.
    Fable has its own, tighter rate limit on Claude Teams, so by default an `exceptionally-hard`
    verdict runs on opus. Only `/tier fable` reaches it: a session started on fable with `/model`
    steps down at the first classifier verdict.
  - A refused fable request falls back to the session's model, as any tier does.
- **Effort (on prompt submit, in parallel).** A second classification labels how
  hard the problem is to think through: `recall-or-lookup` / `routine-reasoning` /
  `tricky-problem` / `hard-open-problem`, mapped to effort low / medium / high / xhigh.
  The classifier never proposes `max`.
  - The `turn.step` hook sends each main-loop request with that effort.
  - A model that takes no effort is sent none.
  - Effort follows the same sticky rule as tiers: up at once, down after `downgradeAfterTurns` lower verdicts.
  - The labels are named for depth rather than answer length. A "three-line answer" design question first came out `low` under a label called `quick-answer`.
- **Self-correction.** The mod registers a `set_tier` tool
  (`mcp__model-tier__set_tier`) that takes `tier`, `effort` or both. Each turn's
  note tells the model the pick (`runs on opus (auto) with high effort (auto)`) and
  asks it to review that pick against the work ahead. The model calls the tool when
  either the tier or the effort is clearly too weak or wasteful. The change applies
  from the next model request. A tier above `maxAutoTier` is left out of the tool's
  schema, and a call that asks for one keeps the current tier.
- **Switching.** A `turn.step` hook rewrites the `model` of every main-loop request.
  Subagent steps are untouched.
- **Subagents.** `general-purpose` / `claude` spawns with no explicit model get a
  model from the same classifier. Agent types that define their own model keep it.
- **Sticky tiers.** Upgrades apply at once. Downgrades need `downgradeAfterTurns`
  consecutive lower verdicts, because every switch re-bills the conversation
  prefix outside the prompt cache. Before the session has sent anything there
  is no cached prefix, so the first verdict applies at once.
- **Classifier timeout.** If the classifier takes longer than
  `classifierTimeoutMs`, the current tier stays and the prompt is not held.
- **Context guards.** Above `maxTokensForHaiku` prompt tokens the session never
  drops to haiku; above `maxTokensForDowngrade` it never steps down at all.
  Loaded into a running session, the mod reads the live context size first.
- **Fallback.** If the API refuses the chosen tier before anything streams, the
  request is retried on the session's own model and a toast says so.

The status line shows the effective tier and effort, e.g. `tier: opus·high (auto)`. `/model` keeps
showing the session's configured model: this mod rewrites requests, not the setting.

## Commands

- `/tier`: show the current tier
- `/tier fable|opus|sonnet|haiku`: pin a tier. The classifier and `set_tier` leave it alone.
- `/tier auto`: return to automatic routing
- `/tier effort low|medium|high|xhigh|max`: pin the effort. `/tier effort auto` releases it.

## Options (`userConfig`)

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | turn routing on/off |
| `downgradeAfterTurns` | `2` | consecutive lower verdicts before stepping down |
| `maxTokensForHaiku` | `150000` | prompt-token ceiling for haiku |
| `maxTokensForDowngrade` | `200000` | above this, the tier only goes up |
| `classifierModel` | `haiku` | model used to label prompts |
| `classifierTimeoutMs` | `3000` | keep the current tier and effort when classifying takes longer |
| `routeEffort` | `true` | also classify and send a reasoning effort per turn |
| `maxAutoTier` | `opus` | highest tier the classifier, subagent routing and `set_tier` may pick; `fable` lifts the cap |

## Development

```sh
claude plugin validate model-tier
claude plugin test model-tier
claude --plugin-dir ./model-tier
```

## Behaviour to know

- `/model` changes after the first request are overridden by the stored tier.
  Use `/tier` instead.
- `--continue` / `--resume` start the tier state fresh, so hysteresis resets.
- After a refused-tier fallback, the status line still shows the intended tier,
  not the model that answered.
- The classifier adds one small model call per prompt (observed 0.7 s to 21 s;
  bounded by `classifierTimeoutMs`).
- Verified on Claude Code 2.1.310: a haiku request over a history that holds a
  signed opus thinking block is accepted.
