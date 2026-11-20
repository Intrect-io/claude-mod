# linear-agent

linear-agent is the Cloudflare Worker behind auto-claude's Linear agent app. Linear treats the app as its own user, with `actor=app`. Issues can be delegated to it, and it reports progress in Linear's agent session. auto-claude's driver reaches it through a small bearer-authenticated API.

- **Webhooks.** It verifies Linear's webhooks and queues agent session events in D1. It answers within Linear's 5 s limit and sends the first activity within its 10 s limit.
- **Token.** It holds the app's OAuth token and refreshes it on a cron.
- **Session API.** It lets the driver post activities, replace the session plan, add the PR link, and create issues, all as the app.

The webhook contract is pinned by `fixtures/linear-agent-v1` (`bun fixtures/linear-agent-v1/run.ts --section worker` from the repository root). Its README lists the Linear facts the code rests on.

## Routes

| Route | Auth | What it does |
|---|---|---|
| `POST /webhook` | `Linear-Signature` (HMAC-SHA256 of the raw body) and `webhookTimestamp` within 60 s | Agent session events (`created` or `prompted`) are written to D1, unique on their key: `created:<session>`, `prompted:<activity>`, else `delivery:<Linear-Delivery>`. The write is awaited for up to 3 s, and a failure answers 503 so Linear retries. A new `created` event gets the first `thought` activity through `ctx.waitUntil`, and the issue's project is looked up after the write. Other events answer 200 and are ignored. |
| `GET /oauth/start` | none | Redirects to `https://linear.app/oauth/authorize` with `actor=app`, `scope=read,write,app:assignable,app:mentionable` and a single-use state kept 10 minutes in KV. |
| `GET /oauth/callback` | state | Exchanges the code at `https://api.linear.app/oauth/token`. It stores the access token, refresh token, expiry, app user (`viewer { id }`) and organization together under the KV key `oauth:token`. An install from a different workspace than the installed one is refused (409). |
| `GET /health` | none | `{ok: true, installed}`. |
| `GET /v1/events?since=&project=` | Bearer `SESSION_TOKEN` | The project's rows after the cursor, oldest first, at most 100, with `cursor`. A row whose project is still unknown is looked up again. While its lookup keeps failing it holds back the rows after it, so the driver's cursor does not pass it, until it is 30 minutes old. |
| `POST /v1/activity` | Bearer | `{sessionId, content, ephemeral?}` to `agentActivityCreate`. `content` is `{type: thought, elicitation, response or error, body}` or `{type: action, action, parameter, result?}`. |
| `POST /v1/plan` | Bearer | `{sessionId, plan}` to `agentSessionUpdate`. The plan holds 1 to 100 `{content, status}` entries and replaces the whole plan; `null` clears it. |
| `POST /v1/external-url` | Bearer | `{sessionId, label, url}` (https only) to `agentSessionUpdate.addedExternalUrls`. |
| `POST /v1/issue` | Bearer | `{team, title, description?, parentId?, projectId?, delegate?}` to `issueCreate`. The team key is resolved to its id, and the team's `auto-claude` label is added when it exists. The issue is delegated to the app user only when `delegate` is true. |

Write routes answer 409 before the app is installed and 502 when Linear refuses, with Linear's message. A token or secret is never logged or returned.

The scheduled handler (cron `0 */6 * * *`) is the only code that refreshes the token. It refreshes when under 12 hours remain, retries once, and writes the rotated pair in one KV put. Linear rotates the refresh token on every refresh and KV is eventually consistent, so a second refresher could lose the pair.

## D1 schema

`migrations/0001_init.sql` creates one table, `events`, with these columns:

- `id` (autoincrement cursor) and `key` (unique);
- `delivery_id`, `action`, `session_id`, `issue_id`;
- `identifier`, `title`, `url`, `prompt`, `signal`;
- `project_id`: `NULL` until it is looked up, `''` when the issue has no project;
- `created_at`.

## Bindings and secrets

`wrangler.toml` binds two resources:

- KV namespace `LINEAR_AGENT_TOKENS` (`0d7d2b95e9984dcaa5eea6de7d5b0f9f`) as `TOKENS`;
- D1 database `linear-agent` (`7b61edcc-47ae-41d7-881e-d85a1d6931f0`) as `DB`.

The custom domain is `linear-agent.intrect.io`. The secrets are set with `wrangler secret put`: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET` (the app's webhook signing secret) and `SESSION_TOKEN` (shared with the driver through `~/.claude/linear-agent.json` `{url, token}`).

## Ship (by hand)

```sh
cd linear-agent
bun install --frozen-lockfile && bun test
wrangler d1 migrations apply linear-agent --remote
wrangler deploy
```

Then install the app once by opening `https://linear-agent.intrect.io/oauth/start`, as a workspace admin of the Linear workspace. auto-claude runs never deploy this Worker.

## Develop

```sh
bun test                                                   # tests: D1 on bun:sqlite with the real migrations, mocked fetch
bunx --package typescript@5.6.3 tsc --noEmit -p .          # type check against @cloudflare/workers-types
```

`scripts/ci.sh` at the repository root runs both.
