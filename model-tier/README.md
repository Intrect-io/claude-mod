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
  - Skipped when no verdict could change the tier: pinned, or already at `maxAutoTier`
    with the context past `maxTokensForDowngrade` (`canTierChange`). Measured 2026-11-03:
    the average main-loop context was ~400k tokens, so this saves one classifier call on
    most turns. The effort classification still runs.
- **Effort (on prompt submit, in parallel).** A second classification labels how
  hard the problem is to think through: `recall-or-lookup` / `routine-reasoning` /
  `tricky-problem` / `hard-open-problem`, mapped to effort low / medium / high / xhigh.
  The classifier never proposes `max`.
  - The `turn.step` hook sends each main-loop request with that effort.
  - A model that takes no effort is sent none.
  - Effort follows the same sticky rule as tiers: up at once, down after `downgradeAfterTurns` lower verdicts.
  - The labels are named for depth rather than answer length. A "three-line answer" design question first came out `low` under a label called `quick-answer`.
- **Self-correction.** The mod registers a `set_tier` tool
  (`mcp__model-tier__set_tier`) that takes `tier`, `effort` or both. A turn
  note tells the model the pick (`runs on opus (auto) with high effort (auto)`) and
  asks it to review that pick against the work ahead. The model calls the tool when
  either the tier or the effort is clearly too weak or wasteful. The change applies
  from the next model request. The note comes only when it carries news:
  - on the first turn;
  - when the tier or effort changed;
  - when the pick may be wrong (a classifier timed out, or its verdict was held back by
    the downgrade rule or the haiku context guard).

  Measured with inkblot: 0 of 6 `set_tier` calls on turns where the pick stood.
  A tier above `maxAutoTier` is left out of the tool's schema, and a call that
  asks for one keeps the current tier.
- **Switching.** A `turn.step` hook rewrites the `model` of every main-loop request.
  Subagent steps are untouched.
- **Subagents.** `general-purpose` / `claude` spawns with no explicit model get a
  model from the same classifier. Agent types that define their own model keep it.
- **Sticky tiers.** Upgrades apply at once. Downgrades need `downgradeAfterTurns`
  consecutive lower verdicts, because every switch re-bills the conversation
  prefix outside the prompt cache. Before the session has sent anything there
  is no cached prefix, so the first verdict applies at once.
- **Classifier timeout.** If the classifier takes longer than
  `classifierTimeoutMs`, the prompt goes on with the current tier. The label
  is not dropped: when it arrives and no newer prompt came in, it decides the
  rest of the turn (the steps after the first tool call), unless the tier was
  pinned meanwhile. After a late answer the classifier counts as slow, and
  prompts stop waiting for it at all until an answer comes in under the
  bound. Measured on 2026-11-01, whole sessions ran at about 21 s per call,
  so waiting 3 s there only delayed every prompt.
  Each timeout and each late label is a line in the log (see [Log and `/tier stats`](#log-and-tier-stats)); those lines are the data for tuning the bound.
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
- `/tier stats [days]`: summarize the log over the last `days` days (default 7); see [Log and `/tier stats`](#log-and-tier-stats)
- `/tier eval [path]`: run the classifier eval (see [Classifier eval](#classifier-eval))

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

## Log and `/tier stats`

`~/.claude/model-tier.log` holds one JSON line per event from every session on the machine, each with
`ts` (ISO time) and `event`:

| `event` | written when | other fields |
| --- | --- | --- |
| `prompt` | a main-loop prompt was classified (`prompt.submit`) | `tier`, `effort` (the pick after it), `from: {tier, effort}` (before), `verdict: {tier, effort}` (what came in time; `null` otherwise), `wantTier` (false: tier classification skipped), `waited`, `timedOut`, `ms` (classifier latency when in time, else `null`), `tokens` (the last request's prompt tokens) |
| `spawn` | a subagent spawn was routed (`agent.spawn`) | `agent` (its type), `tier` (`null`: it kept the parent's model), `timedOut`, `ms` |
| `switch` | a main-loop request was answered by another model than the one before, so its prefix was written again | `from`, `to` (model ids), `tokens` (that request's prompt tokens) |
| `turn` | a main-loop turn finished (`turn.complete`) | `models: {<model id>: {requests, promptTokens, cacheWriteTokens, outputTokens}}` |
| `classifier-timeout` | a prompt waited for a label and the bound passed | `classifier` (`tier`, `effort` or `subagent`), `ranMs`, `kept: {tier, effort}` |
| `classifier-late` | a label arrived after its prompt went on | `ms` (real latency), `applied`, `waited`, `wantTier` |

`/tier eval` goes through the same `labelPrompt` but writes no line: only the prompt and spawn hooks log.

**Writing.** `$.fs` can only rewrite a whole file. When two sessions read and rewrite it at the same time, one of them loses its line. So each line is appended by the shell (`sh -c 'cat >> …'`), as one small write. Measured: 8 concurrent writers × 200 lines gave 1600 whole lines.
- Past 3 MiB the file moves to `model-tier.log.1`, replacing the older one. The two files together hold the last 3 to 6 MiB, which is at least 5000 lines. Each stays under the 4 MiB that `$.fs.read` accepts.
- Two sessions that cross the bound in the same instant can both rotate, and then the older file is lost.
- Where the shell cannot run, the mod falls back to rewriting the file with the last 5000 lines. Lines from concurrent sessions can be lost there.

**Reading.** `/tier stats [days]` reads both files and reports the last `days` days (default 7):
- prompts classified, and how many skipped the tier classification;
- picks by tier and by effort (`session`: the session's own effort);
- prompts whose tier changed, and model switches on the main loop with the prompt tokens they wrote again;
- classifier latency p50/p90 (prompts and spawns answered in time, plus late labels), with late and timed-out counts;
- routed spawns by tier (`kept`: no label in time);
- main-loop requests and tokens per model.

## Classifier eval

Label names steer the classifier: renaming one effort label moved a hard design
prompt from `low` to `high`. The eval measures a label or classifier change
before it ships.

```sh
claude -p --plugin-dir model-tier "/tier eval model-tier/eval/prompts.jsonl"
```

- `eval/prompts.jsonl` holds one `{"prompt", "tier", "effort", "why"}` per line:
  the expected tier and effort, by the label meanings in `hooks/label.ts`, and why.
  Borderline prompts are kept on purpose, and their `why` names which way they lean.
- `/tier eval [path]` labels each prompt one at a time with `labelPrompt`, the same
  function the prompt hook and subagent routing call. It uses the configured
  `classifierModel` and a 30 s timeout, so a slow answer is still scored.
- The tier is scored uncapped (`maxAutoTier` is routing policy applied after the label),
  so `exceptionally-hard` reads as `fable`.
- The run is written to `last-run.json` beside the prompt set. It holds per-prompt results,
  tier and effort accuracy, timeouts, latency p50/p90/max, and how many prompts took longer
  than `classifierTimeoutMs` (those keep the old pick in a session).
- `eval/baseline.json` records four live runs on the committed prompt set, with per-prompt
  hits. Tier accuracy ranged 0.667 to 0.75 and effort accuracy 0.5 to 0.625, so the spread is
  0.083 (2 prompts) for tier and 0.125 (3 prompts) for effort.
- Two of the four runs hit a ~21 s per-call latency floor (likely the endpoint behind
  `ANTHROPIC_BASE_URL`; not traced), and one of those lost 3 prompts to the 30 s bound.
  Look at `timeouts` before reading accuracy.

**Rule.** A change to a label, the label prompt or the classification call must not drop
tier or effort accuracy below the baseline minus the run-to-run spread. Today that is tier
0.708 and effort 0.583: the lowest baseline run without timeouts. Run the eval at least twice
on the change, rerun any run that reports timeouts, and every remaining run must meet both
numbers. When the prompt set changes, record a new baseline in the same PR.

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
