# linear-agent-v1: pinned fixtures for the Linear agent app

These fixtures judge the code that connects auto-claude to Linear's agent model. They cover three parts:

- **Worker.** A Cloudflare Worker at `linear-agent/` that receives Linear's webhooks and holds the app's OAuth token.
- **Bridge.** auto-claude's side of the agent session, which turns sessions into queue lines and reports progress back.
- **Autonomy.** auto-claude creating and decomposing issues itself.

They were written and checked against a throwaway reference implementation before the real code existed. `manifest.sha256` lists the hash of every file here, and the milestone checks pin the hash of the manifest itself. A milestone can add code, but it cannot edit, drop or weaken a fixture or `run.ts` and still pass.

```sh
bun fixtures/linear-agent-v1/run.ts                    # every section
bun fixtures/linear-agent-v1/run.ts --section worker   # or bridge, or autonomy
(cd fixtures/linear-agent-v1 && shasum -a 256 -c manifest.sha256)
```

`gen.ts` wrote `webhook.json` and shows how each signature was made. Its secret is a fixture value, not a Linear secret.

## Facts the contracts rest on

These were checked on 2026-11-20 against Linear's developer docs (webhooks, agent interaction, OAuth 2.0) and the published GraphQL schema (`packages/sdk/src/schema.graphql`).

- **Signature.** `Linear-Signature` is the hex HMAC-SHA256 of the raw request body, keyed with the webhook signing secret.
- **Timestamp.** The JSON body carries `webhookTimestamp`, in Unix milliseconds. Linear recommends rejecting a payload more than a minute away from the receiver's clock, and checking the signature first.
- **Delivery id.** `Linear-Delivery` is a UUID per payload.
- **Response and retries.** The receiver must answer 200 within 5 s. Any other status or a slower answer counts as a failure. Linear retries after 1 min, 1 h and 6 h, and may disable the webhook if failures continue.
- **First activity.** After a `created` agent session event, the agent must send an activity or update its external URL within 10 s, or the session is marked unresponsive.
- **Agent session payload.** `AgentSessionEventWebhookPayload` has these fields:
  - `action`: `created` or `prompted`;
  - `agentSession` (`id`, `issueId`, `issue{id, identifier, title, url, teamId, team}`, ...);
  - `agentActivity` (`content: JSONObject`, ...) and `promptContext` (sent on `created` only);
  - `appUserId`, `oauthClientId`, `organizationId`, `webhookTimestamp`.
  - The schema does not fix the `type` string. `agentSession.issue` and `issueId` are both nullable. The issue payload carries **no project**, so the Worker has to look the project up itself.
  - On `prompted`, the docs place the person's message in `agentActivity.body`. The schema carries it in `agentActivity.content` (as `{type: "prompt", body}`). The contract reads `content.body` first and falls back to `body`.
- **Stop signal.** `agentActivity.signal` (`AgentActivitySignal`) can be `stop`. The agent must then halt and end with a `response` or `error` activity.
- **Plan limits.** `AgentSessionUpdateInput.plan` takes 1 to 100 entries, and `null` clears the plan.
- **Other subscribed payloads.** These are `AppUserNotification`, `PermissionChange` and `OAuthApp` (`action: revoked`).
- **Mutations.**
  - `agentActivityCreate(input: {agentSessionId, content, ephemeral?, signal?})`. The content types are `thought`, `elicitation`, `response`, `error` (each `{type, body}`) and `action` (`{type, action, parameter, result?}`).
  - `agentSessionUpdate(id, input: {plan, externalUrls, addedExternalUrls, removedExternalUrls, ...})`.
  - `plan` is `[{content, status: pending|inProgress|completed|canceled}]`, and every update replaces the whole plan.
  - `issueCreate(input: {teamId, title, description, parentId, projectId, delegateId, labelIds, stateId, ...})`.
- **OAuth.**
  - Authorization goes to `https://linear.app/oauth/authorize?client_id&redirect_uri&response_type=code&scope=read,write,app:assignable,app:mentionable&actor=app&state`.
  - Tokens come from `POST https://api.linear.app/oauth/token`, form-encoded.
  - Access tokens expire after 24 h. Refresh tokens last 30 days.
  - Every refresh (`grant_type=refresh_token`) rotates both tokens. A lost response can be recovered by retrying with the same refresh token within 30 min.
  - `{ viewer { id } }` with the app token gives the app user.

## Contracts

### `linear-agent/src/webhook.ts`

This module imports under plain bun with no Cloudflare runtime. It uses Web APIs only (`crypto.subtle`, `Headers`, `Response`).

- **`verifyWebhook(raw, signature, secret, nowMs)`** returns `Promise<{ok: true, body} | {ok: false, status, reason}>`. It never throws, whatever the input.
  - It checks in order, and the first failure decides.
  - **Signature:** missing, not 64 hex characters, or not equal in any byte to the HMAC of `raw`'s UTF-8 bytes gives `401 'signature'`. The comparison is constant-time. The runner cannot measure timing, so review checks it.
  - **JSON:** a body that does not parse gives `400 'json'`.
  - **Timestamp:** a body that is not an object, a `webhookTimestamp` that is not a JSON number, or one that differs from `nowMs` by more than 60 000 ms in either direction, gives `401 'timestamp'`. Exactly 60 000 ms is accepted.
- **`classifyEvent(body)`** returns `{kind: 'session', event} | {kind: 'ignore', reason}`.
  - An agent session event is a body whose `agentSession.id` is a string, whose `action` is `created` or `prompted`, and that names an issue (`agentSession.issue.id` or `agentSession.issueId`). This holds whatever `type` says. Everything else is ignored.
  - `event` carries these fields:
    - `{action, sessionId, issueId, identifier, title, url}`, taken from `agentSession` and `agentSession.issue`;
    - `prompt`: `promptContext` on `created`; on `prompted`, `agentActivity.content.body`, falling back to `agentActivity.body`;
    - `signal`: `agentActivity.signal` when it is a string, whatever its value (`stop` asks the agent to halt).
  - Both actions carry the issue fields, so the Worker can route a prompt or a stop like the session that it belongs to.
- **`handleWebhook(raw, headers, deps)`** returns `Promise<Response>`.
  - `deps` has these members:
    - `secret`, `now` and `writeTimeoutMs` (3000 when absent);
    - `enqueue(event & {key, deliveryId?})`, which writes the event durably and resolves `true` when it is new or `false` when `key` was already queued;
    - `thought(sessionId, body)`;
    - `after(promise)`, which is `ctx.waitUntil`.
  - **Failed verification:** respond with its status and call nothing.
  - **Ignored events:** respond 200 and call nothing. Answering 200 keeps Linear from retrying, and from disabling the webhook.
  - **Session events:** await `enqueue` for at most `writeTimeoutMs`.
    - **The key:**
      - on `created`, `created:<sessionId>`;
      - on `prompted`, `prompted:<agentActivity.id>`;
      - with no activity id, `delivery:<Linear-Delivery>`.

      The dedup does not rely on Linear reusing a delivery id across retries.
    - A write that rejects or does not finish in time gives **503** for either action, so Linear retries. A write that finishes in time is waited for, however long it takes up to the limit. Nothing is recorded as seen and no thought is sent.
    - `false` gives 200 and nothing else.
    - `true` gives 200. On `created`, one `thought` (non-empty body) for that `sessionId` is then handed to `after` and never awaited before the answer, so a slow Linear API cannot delay it. That promise must settle and never reject, even when `thought` rejects.
    - A delivery answered 503 leaves no trace. Its retry is handled like a first delivery.
- **Not tested here, but required of the Worker:**
  - `enqueue` is a D1 insert keyed by `key` (unique). It stores the issue's project, looked up with `issue(id){ project { id } }` using the app token. A row whose lookup failed keeps a null project and is looked up again when it is read.
  - The timestamp rule follows Linear's advice. Whether a retry carries a fresh `webhookTimestamp` is not documented, so the e2e check watches one retry.

### `auto-claude/hooks/agent.ts`: bridge

This module imports under plain bun with no engine. It may import `./queue`. An issue identifier is a team key of 1 to 10 characters (`[A-Z][A-Z0-9]{0,9}`), a dash and a number.

- **`planOf(queueText, currentCondition?)`** gives the Linear plan for `.claude/goals.md`.
  - It returns one entry per queue item, using `parseQueue` semantics and the queue's order.
  - The status comes from the mark, and the mark wins:
    - `[x]` gives `completed` and `[!]` gives `canceled`.
    - Every open line whose condition, before whitespace is collapsed, is exactly `currentCondition` (case-sensitive, no trimming) gives `inProgress`.
    - Any other open line gives `pending`.
  - `content` is the condition with whitespace collapsed. Content longer than 200 characters becomes its first 199 characters plus `…`.
  - **Limits.** Linear accepts 1 to 100 entries.
    - Over 100, the earliest `completed` or `canceled` entries, taken by position whatever their kind, are dropped until 100 remain. Then the list is cut to its first 100.
    - An empty queue gives `[]`, and the caller sends `plan: null`.
- **`eventLines(events, projectId, known, since)`** returns `{lines, sessions, prompts, stops, cursor}`. `events` are the Worker's rows `{id, action, sessionId, projectId, identifier, title?, prompt?, signal?}`.
  - **Filtering:** a row whose `projectId` is not `projectId` is skipped, whatever its action. So is a row with a null or missing project, or an identifier that does not match the grammar exactly (anchored, case-sensitive). Actions other than `created` and `prompted` are ignored.
  - **`created`:**
    - When the issue is not yet in `sessions` (which already holds earlier rows of the same call), it adds one queue line starting `- [ ] [<identifier>] ` and mentioning the title.
    - Comment markers and colons are removed repeatedly until none can re-form, including where the title meets the text that follows it.
    - The line is a single line with no `::`, `<!--`, `-->`, carriage return, vertical tab, form feed or no-break space. Colons are removed until no `::` is left, even across spaces (`: :`), because `auto-claude/hooks/queue.ts` `parseQueue` must read the line back as one open item with **no check**. A title is untrusted text, and a check is a shell command the run executes.
    - When the issue is already in `sessions`, it adds no line, and the new session id replaces the old one.
  - **`prompted` with `signal: 'stop'`:** it yields `{identifier, sessionId}` in `stops` only, whether or not it has text. Only the exact string `stop` counts. Any other signal, `STOP` included, is an ordinary prompt.
  - **Other `prompted`:** it yields `{identifier, sessionId, text}` in `prompts`, with the text trimmed. An empty text is dropped.
  - **Sessions:** `sessions` is a new object that starts as a copy of `known`. `known` itself is not changed.
  - **Cursor:** `cursor` is the highest row id seen in any order, skipped rows included, or `since` when there are none.
- **`activityFor(moment)`** maps a moment of the run to an activity's content.
  - The moment kinds are `start`, `held`, `deferred`, `diff-judge-hold`, `awaiting-human`, `merged` and `stopped`.
  - **`start`** is `{type: 'action', action, parameter}`, and the parameter names the goal.
  - **The four hold kinds** are `{type: 'elicitation', body}`. The body contains the reason, and the PR URL when given.
  - **`merged`** is `{type: 'response', body}`, and the body contains the PR URL.
  - **`stopped`** is `{type: 'response', body}` naming the goal. It is the final activity Linear expects after a stop.

### `auto-claude/hooks/agent.ts`: autonomy

- **`fingerprint(kind, key)`** is `auto-claude:fp=<kind>:<first 12 hex of sha256(key)>`.
- **`issueCandidates({held, ciRed, existing, createdToday, cap})`** returns `[{kind, key, fingerprint, title}]`.
  - **Held milestones:** a held milestone whose `issues` list is empty is a `held` candidate, keyed by its whole goal. Its goal text does not matter.
  - **Red workflows:** a default-branch workflow red on at least 2 polls is a `ci-red` candidate, keyed by its workflow name.
  - **Keys:** the key is the goal or workflow name exactly as given, with no trimming and no tag stripping.
  - **Dedup:** a fingerprint in `existing` is skipped, and so is one seen earlier in the same call. Skipped candidates do not count toward the cap. `existing` holds the fingerprints found in the project's open issues and in those closed within the last 30 days, so an issue a person closes is not filed again the next day.
  - **Order:** held candidates come first, then ci-red, each in input order.
  - **Cap:** at most `max(0, cap - createdToday)` are returned.
  - **Titles:** exactly `` `Held: ${goal}`.slice(0, 100) `` and `` `CI red on the default branch: ${workflow}`.slice(0, 100) ``.
- **`decomposeTargets(queueText, sessionIdentifier)`** returns `[{line, title}]`.
  - **Leading tags** are the `[KEY-123]` tokens at the start of a condition, adjacent or separated by any whitespace. A tag later in the text is not a leading tag.
  - The targets are open lines, with or without a check, with no leading tags, or with only the session's own issue among them, compared exactly. A line that also names another issue is not a target.
  - `line` is the raw line number in the text, as `parseQueue`'s `line` gives it, counting headings and blank lines.
  - `title` is the condition without its leading tags, at most 80 characters.
  - Fewer than 2 targets means nothing is decomposed (`[]`).
- **`tagLine(queueText, line, id)`** replaces that raw line's leading tags (however many) with the single tag `[id]`, or adds it to an untagged line. The line keeps its own bullet and indentation, tabs included. Every other line stays byte for byte the same, including CRLF ends and trailing spaces, even when an identical line comes earlier.

## How these fixtures were hardened

Three rounds of red-team agents wrote implementations that break a clause above and still pass. Every loophole they found became a case, and each round's fixes were checked by putting three of its loopholes back and watching the runner fail.

- **Round 1** found 34 loopholes and 5 contract defects. The defects were a lost event when the queue write failed after the 200, an ignored stop signal, the 1 to 100 plan limit, sessions without an issue, and dedup on a delivery id that retries may not reuse.
- **Round 2** found 34 more, including a check injection through `:::` in an issue title. That one was in the reference implementation itself.
- **Round 3** found 24, including injection through a newline in an identifier, comment markers that re-form, and a colon where the title meets the rest of the line.

Two things are still not judged by the runner. The milestone diff judge and the review before the Worker ships cover them:

- whether the signature comparison is constant-time;
- behaviour that only a live Linear workspace shows, such as the retry timestamp and the real `type` string.
