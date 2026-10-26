# fleet: Claude 세션 오케스트레이터 (허브 대시보드 + 세션 bridge mod + Slack)

## Context
지금 오케스트레이션은 "어떤 Claude Code 터미널 세션 하나를 orchestrator로 지정"하는 방식이다.
`~/.claude/orchestration-grant.json`의 `orchestrator: "house-rules-plugin-cleanup"`과 CLAUDE.md §6.5가 그 예다.
이 방식에는 문제가 세 가지 있다.
- 오케스트레이터가 터미널 세션 하나에 묶인다. 그 세션의 컨텍스트, 컴팩션, 재시작에 운명이 걸린다.
- 세션 간 통신이 1:1 SendMessage뿐이다. 브로드캐스트나 저장소별 채널, 전체 상태 개관이 없다.
- 사람이 밖에서 개입할 경로가 없다. Slack 같은 외부 경로가 없다.

목표는 세 가지다.
1. 세션끼리 IRC식 채널(#all, #<repo>, DM)로 대화하고, 1:1은 네이티브 SendMessage로도 대화한다.
2. 최상위 오케스트레이터 에이전트는 Claude Code 세션이 아니다. 별도 로컬 웹 대시보드(허브 daemon) 안에서
   Agent SDK headless 프로세스로 돈다.
3. Slack intrect 워크스페이스와 양방향으로 연동한다. vega 앱에 bot과 Socket Mode를 추가한다.

사용자 결정 (2026-10-26)
- 통신: Hub 채널 + 네이티브
- 대시보드: 로컬 웹 (Bun)
- Slack: vega 앱에 bot과 Socket Mode 추가. 토큰 발급은 사용자가 api.slack.com에서 직접 하고, keychain에 보관한다.
- 권한: grant 파일 형식을 유지하고 허브가 발급한다.

## 구성 (저장소 레이아웃)
claude-mod 저장소에 둘을 함께 둔다. marketplace는 mod만 나열한다.
- `fleet/`: Claude Code mod. 세션마다 로드되는 bridge다. `.claude-plugin/plugin.json`, `hooks/register.ts`, `types/index.d.ts`, tests를 둔다.
- `fleet-hub/`: Bun daemon. mod가 아니므로 marketplace.json에 넣지 않는다. 내용은 HTTP over UDS, 웹 대시보드, orchestrator agent, Slack이다.
- 실행 0단계: 이 계획을 `fleet-hub/PLAN.md`로 복사한다. 루트 `plan.md`는 harness 계획이므로 덮어쓰지 않는다.

```
 [Slack intrect] ⇄ Socket Mode ⇄ ┌──────────── fleet-hub (Bun) ────────────┐ ⇄ http://127.0.0.1:<port> 브라우저 대시보드
                                 │ channel bus · session registry · grant  │
                                 │ orchestrator agent (Agent SDK, headless)│
                                 └──────▲───────────────────────┬──────────┘
                     HTTP over UDS      │ telemetry/messages    │ 세션 방향 전달 (Phase 0 게이트로 결정)
                     ~/.claude/fleet/hub.sock                   ▼
                 [CC 세션 A + fleet mod]  ⇄ SendMessage ⇄  [CC 세션 B + fleet mod]
```

## Phase 0: 전달 경로 실측 게이트 (구현 전, pass/fail)
허브 → 세션 방향이 핵심 미지수다. 세 후보를 이 순서로 실측하고, 처음 통과하는 것을 채택한다.
- (a) **네이티브 peer**: Agent SDK headless 세션이 `ListAgents`에 보이고 `SendMessage`로 터미널 세션에 닿는지 본다.
  스크래치 스크립트 `fleet-hub/testing/peer_probe_261026_v1.ts`로 확인한다.
  통과하면 orchestrator가 직접 SendMessage를 보낸다. 이때 `harness/hooks/grant.ts`의 `from-name` 검증이 그대로 동작한다
  (grant.orchestrator = SDK 세션 이름).
- (b) **MCP channel**: `PromptOrigin.kind: 'channel'` 경로를 본다. 허브가 channel-capable MCP server
  (fleet mod가 manifest `mcpServers`로 ship하는 stdio 프록시 → hub.sock)가 되어 push로 넣는다.
  공식 문서의 capability 선언과 opt-in 조건(플래그, allowlist)을 확인한다.
- (c) **fallback: bridge mod long-poll**: `session.start`에서 `$.process.spawn`으로 상주 루프를 시작한다
  (doc의 "bridge watch" 예시 패턴). 또는 `$.http.fetch(…/inbox?wait=25, { socketPath })` long-poll을 쓴다.
  받은 메시지는 idle이면 `$.prompt.submit`으로, 턴 중이면 다음 idle까지 큐에 둔다.
  `$.prompt.submit`은 세션이 idle일 때만 턴이 된다. 따라서 오케스트레이터 지시는 턴과 턴 사이에 도착한다.
- 산출물: 실측 결과 3줄을 `fleet-hub/PLAN.md`에 기록하고 채택 경로를 확정한다.
  grant.ts 수정 여부는 채택 경로에 따라 정한다. (a)면 수정하지 않는다. (b)/(c)면 origin이 `plugin: fleet` 또는 `channel: fleet`인 것을 orchestrator 신원으로 인정한다.

### Phase 0 실측 결과 (2026-10-26)
- (a) 네이티브 peer: Agent SDK 세션이 ListAgents/SendMessage peer로 등록되는지는 문서에 없다. headless 문서가 SDK에 `--bare`를 권장하는데, `--bare`면 소켓이 없다. 따라서 채택하지 않았다. 보조 경로로만 남긴다.
- (b) MCP channel: 세션마다 `--dangerously-load-development-channels` 플래그와 경고 승인이 필요하고, SDK에서는 등록되지 않는다. 채택하지 않았다.
- (c) 채택: fleet mod가 hub.sock을 2초 간격으로 short-poll하고 `$.prompt.submit`으로 넣는다. `$.http.fetch`에 timeout이 없어서 long-poll 대신 short-poll로 했다.
  grant 판정은 fleet mod의 `wire.ts`가 직접 붙인다. harness `grant.ts`는 고치지 않았다. harness의 grant 훅은 `session.receive`(peer)에만 걸리고, fleet 메시지는 plugin origin prompt라서 서로 겹치지 않는다.
- E2E 실측 1회차: orchestrator가 `send_to_session`을 보내자 세션 prompt에 INVALID(만료) verdict가 붙었고, 세션이 `fleet_post @fleet-hub PONG`으로 답해 orchestrator가 수신했다. 통과.

### 추가 결정 (2026-10-26, 사용자 요청)
- 모델 트래픽은 cc-router로 보낸다. 허브가 settings.json의 env를 읽어 SDK `env`로 넘긴다.
  실측: router env를 제거한 셸에서 허브를 띄웠다. orchestrator 세션(`entrypoint: sdk-cli`)의 요청이 cc-router `recentLogs`에 `type: route`로 기록됐다.
- 원격 접근은 Tailscale로 한다. tailnet IPv4에 listen하고, 본인 기기는 `tailscale whois` UserID로 토큰 없이 통과시킨다. 이 노드 자신의 IP는 신뢰에서 제외한다.
  실측: vela 노드에서 토큰 없이 200, 로컬에서 자기 tailnet IP로 401.
- 관찰: SDK 세션도 `~/.claude/sessions`에 `messagingSocketPath`를 가진 peer로 등록된다(`name: fleet-bd`). 따라서 (a) 네이티브 SendMessage 경로도 가능해 보인다. 아직 실측하지 않았다.

### 네이티브 경로 채택 (2026-10-26, 사용자: "다른 세션들이랑 소통을 안 한다")
- 허브가 세션 레지스트리를 읽어 mod 없는 세션도 표시한다(`via=native`). orchestrator는 `--name fleet-hub`, `tools: ['ListAgents','SendMessage']`, `settings.crossSessionInbound: 'accept'`로 띄운다.
  실측: probe 세션으로 왕복 성공(PONG-NATIVE-2). harness grant 검사가 `from-name="fleet-hub"`를 VALID로 판정했다.
- grant 발급, 승인, 허브 재시작 시 orchestrator에게 mandate를 전달한다. 실측: idle 세션 3곳에 Linear 작업을 지시했고 2곳에서 답장을 받았다.

## Phase 1: fleet mod (세션 → 허브 telemetry, 필수)
`fleet/hooks/register.ts`. harness 구조를 따른다. 순수 함수 + register 체인 + `/fleet` 명령 + `$.store` 토글.
- `session.start`: `$.session.id() / cwd() / repo()`와 세션 이름으로 `POST /sessions/hello`를 보낸다.
  리로드되면 register와 session.start가 다시 돈다. 그래서 허브는 session id로 upsert하고, mod는 module 변수에 의존하지 않는다.
- `turn.start` / `turn.complete`: busy/idle 상태와 마지막 assistant 요약 1줄(최대 200자)을 보낸다.
- 대기 중인 AskUserQuestion: 감지 로직을 새로 만들지 않는다. harness `ask-default.ts`의 `unanswered()` 순수 함수를 import해서
  `waiting_on_user`를 보고한다. 대시보드에 "사용자 대기" 배지로 띄운다.
- `session.send` / `session.receive`: 1:1 메시지 메타(from, to, 첫 줄)를 허브 DM 로그에 미러링한다. 본문은 토글이 on일 때만 보낸다.
- 채널 도구: `$.tool.register`로 `fleet_post({ channel, text })`, `fleet_read({ channel, since })`, `fleet_who()`를 등록한다.
  모델이 #all, #<repo>, DM(session id)을 IRC처럼 쓴다. 채널 가입은 자동이다: #all, 그리고 `$.session.repo()`로 정하는 #<repo>.
- 허브 장애 처리: 모든 fetch에 timeout 2s와 지수 backoff(최대 60s)를 둔다. 허브 다운은 모델 컨텍스트에 절대 넣지 않는다.
  `$.ui.status('fleet: hub offline')`만 띄운다.
- 명령: `/fleet status | on|off | channels | join <ch> | part <ch>`.

**메시지 스키마 (허브와 mod 공통, `fleet-hub/src/schema.ts` 1곳에 정의)**
```ts
type Msg = { id: string; ts: number; channel: string /* "#all" | "#repo" | "@<sessionId>" | "#slack" */;
             from: { kind: 'session' | 'orchestrator' | 'human' | 'slack'; id: string; name: string };
             text: string; replyTo?: string }
type SessionInfo = { id: string; name: string; cwd: string; repo?: string; branch?: string;
                     state: 'idle' | 'busy' | 'waiting_on_user' | 'offline'; lastSeen: number; summary?: string }
```

## Phase 2: fleet-hub (Bun)
- `src/server.ts`: `Bun.serve`를 두 곳에 연다.
  - `unix: ~/.claude/fleet/hub.sock` (mod용, 0600)
  - `127.0.0.1:<port>` (대시보드용). 기동 시 생성한 랜덤 토큰을 쿠키로 받는다.
  WebSocket으로 대시보드에 실시간 push한다.
- `src/bus.ts`: 채널 bus와 세션 레지스트리. SQLite(`bun:sqlite`) `~/.claude/fleet/fleet.db`를 쓰고 WAL 모드로 둔다.
  메시지는 append-only로 쌓고 90일 후 prune한다. 세션이 heartbeat 90s 동안 없으면 offline으로 바꾼다.
- `src/orchestrator.ts`: Agent SDK로 long-lived streaming-input `query()`를 돌린다.
  패키지명과 API는 구현 시 claude-api 스킬과 공식 문서로 확인한다. 기억에 의존하지 않는다.
  - 커스텀 도구는 in-process SDK MCP server로 준다:
    `list_sessions`, `post(channel,text)`, `send_to_session(id,text)`(Phase 0 채택 경로로 전달),
    `read_channel`, `issue_grant/revoke_grant`(사용자 승인 필수, 아래 참고), `slack_post`.
  - 대시보드 채팅과 Slack 멘션이 orchestrator에 user turn으로 들어간다. 세션 이벤트(waiting_on_user, 오류, 장기 idle)는 요약 digest로 주기적으로 넣는다(기본 5분).
  - 모델은 최신 Opus를 쓴다. 비용 상한을 env로 둔다(일일 토큰 예산 초과 시 정지 + Slack 알림).
- `web/`: 단일 HTML 대시보드. 정적 파일이고 빌드 단계가 없다.
  세션 카드(상태·repo·branch·요약·대기 배지), 채널 탭, orchestrator 대화창, grant 패널(현재 grant, 발급/연장/철회 버튼)로 구성한다.
- 기동: `launchd` plist `~/Library/LaunchAgents/com.unohee.fleet-hub.plist`를 둔다. 사용자 승인 후 설치한다.

## Phase 3: grant (권한)
- 형식은 기존 `~/.claude/orchestration-grant.json` 그대로다. `orchestrator` 값만 Phase 0에서 채택한 신원(예: `fleet-hub`)으로 바꾼다.
- **발급은 대시보드의 사람 버튼으로만** 한다. orchestrator 에이전트의 `issue_grant`는 "발급 요청"만 만들고,
  대시보드나 Slack 버튼으로 사용자가 승인해야 파일이 써진다. 에이전트가 스스로 자기 권한을 늘리지 못하게 하기 위해서다.
- `forbidden` 기본값은 현행 grant의 6개 항목을 복사한다.
- 현행 grant는 `2026-10-26T10:00+09:00`에 만료된다(오늘). 새 발급은 이 기능이 완성된 뒤 사용자가 한다.
- harness `grant.ts`는 Phase 0 결과에 따라 신원 인식만 확장한다. VALID/INVALID 판정 로직은 바꾸지 않는다.

## Phase 4: Slack (intrect, vega 앱)
- 사전 작업은 사용자가 한다. vega 앱에 Bot User, Socket Mode, App-Level Token(`connections:write`)을 추가한다.
  bot scope는 `app_mentions:read, chat:write, channels:history, im:history, im:write`다.
  토큰은 keychain `vega-slack-bot` / `vega-slack-app`에 넣는다(service 이름은 확정 시 기록).
  허브는 `security find-generic-password -w`로 읽는다. 토큰을 파일, 로그, git에 두지 않는다.
- `src/slack.ts`: `@slack/bolt` Socket Mode를 쓴다.
  - 수신: 지정 채널의 멘션과 bot DM을 받는다. `SLACK_ALLOWED_USERS`(사용자 본인 ID)만 orchestrator user turn으로 넣고, 나머지는 무시하고 로그만 남긴다.
  - 발신: orchestrator의 `slack_post`, 그리고 이벤트 알림(세션 waiting_on_user 5분 이상, 오류, grant 만료 30분 전).
  - grant 승인 요청은 Block Kit 버튼으로 보낸다. 사용자 ID를 검증한 뒤 승인으로 처리한다.
- 허브의 `#slack` 채널로 Slack 대화를 미러링한다. 세션들도 `fleet_read('#slack')`로 볼 수 있다.

## 범위 밖 (이유)
- 실제 IRC 프로토콜 포트: 사용자가 Hub 채널 방식을 골랐다. 나중에 게이트웨이로 붙일 수 있게 bus만 분리해 둔다.
- `~/.claude/sessions/*.json` + peerToken으로 엔진 UDS에 직접 접속: 내부 프로토콜이라 버전마다 깨진다.
- 원격(폰) 접근: 로컬 전용이다. Slack이 원격 경로 역할을 한다.

## 검증 (end-to-end)
1. `claude plugin validate fleet`, `claude plugin test fleet`, `tsc -p fleet`. 순수 함수(스키마 파싱, backoff, 채널 결정) 테스트를 둔다.
2. `cd fleet-hub && bun test`로 bus, grant 승인 흐름, Slack 사용자 필터를 확인한다.
3. 실측:
   - 허브를 기동하고 fleet mod를 로드한 `claude` 세션 2개를 띄운다.
   - 대시보드에 두 세션 카드가 idle로 보이는지 확인한다.
   - 세션 A의 모델이 `fleet_post('#all', …)`를 보내면 세션 B의 `fleet_read`와 대시보드에 보이는지 확인한다.
   - 대시보드에서 grant를 발급한 뒤 orchestrator가 세션 B에 지시를 보내면, B의 transcript에 `[harness grant check] VALID`가 찍히는지 확인한다.
   - grant를 철회한 뒤 같은 지시가 INVALID로 나오는지 확인한다.
   - 세션 B에서 AskUserQuestion을 띄우면 대시보드에 대기 배지가 뜨는지, 5분 뒤 Slack 알림이 오는지 확인한다.
   - intrect에서 bot을 멘션하면 orchestrator가 응답하는지, 허용 목록 밖 사용자의 멘션이 무시되는지 확인한다.
   - 허브를 kill했을 때 세션 상태줄에 `hub offline`만 뜨고 모델 컨텍스트에 아무것도 들어가지 않는지, 재기동하면 자동 재연결되는지 확인한다.
4. 배포 전에 CodeQL 감사를 한다(자격증명 표면이므로 CLAUDE.md §5). `mcp__plugin-authoring__scan_secrets`로 비밀 스캔을 한다.
