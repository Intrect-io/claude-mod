# harness: 자체 하네스(rules·skills·scripts)를 하나의 통합 mod로

## Context
사용자의 하네스는 대부분 산문이다. `~/.claude/CLAUDE.md`, `rules/*.md` 11개, skills/commands, `SessionStart` 셸 훅이 여기에 속한다.
그래서 모델이 기억해야만 지켜진다. 탐색 결과는 다음과 같다.
- "절대·반드시·금지"인데 아무도 강제하지 않는 규칙이 12개다. Linear 요청 시에만, Cancel/분할 승인, 메모리 비밀, 주문 승인, §6.5 grant 검증 등이다.
- report-lint는 꺼져 있다. 이번 세션에서도 영어 보고가 반복됐지만 잡히지 않았다.
- memory-GC 배너는 매 세션 모델 컨텍스트에 숫자 5개를 주입한다. 현재 깨진 링크 415, 아카이브 가능 576이다.
- `/status`·`/slim`·`/commit`·heartbeat-loop는 결정적 단계가 대부분인데 산문으로 실행된다. `commit.md`는 이미 폐지된 openswarm 리뷰를 아직 호출한다.
- goal-mode가 house-rules의 `shell.ts`를 복제해 쓴다.

사용자 결정: **house-rules를 확장해 `harness`로 개명**한다. goal-mode·model-tier는 별도로 유지한다.
범위는 4개 그룹 전부다. **report-lint는 강화한 뒤 기본 on**으로 한다.

**범위에서 뺀 것 (이유 명시)**
- 플러그인 간 status line 통합: 플러그인마다 `$.ui.status` 슬롯이 따로라 병합 없이는 불가능하다.
- goal-mode와의 Stop 훅 순서: `dependencies`는 `$` 인터페이스 공유만 하고 순서는 정하지 않는다. 해결하지 않고 현행을 유지한다.
- 은퇴 훅 부활 금지 목록(stop-quality-gate, fake-data-guard, cxt-* 등)은 다시 만들지 않는다.

## 공통 원칙
- **결정적이고 모호하지 않으면 deny**한다. **휴리스틱이면 context note나 toast만** 쓰고, 오탐 실측 후에 deny로 승격한다.
- 새 기능은 기존 구조를 그대로 따른다.
  - 순수 check 함수가 refusal 문자열을 반환한다 (`guards.ts` 패턴).
  - `register.ts`의 수동 체인에 연결한다. 엔진은 플러그인당 matcher 없는 훅을 이벤트마다 하나만 받는다.
  - 기능별 토글을 두고 `/harness on|off <feature>`로 켜고 끈다.
- 세션 도중 리로드돼도 상태를 잃지 않게 한다. model-tier에서 겪은 버그와 같은 종류다.
  필요한 상태는 `session.start`에서 `$.session.messages()`와 `$.session.usage()`로 다시 채운다.
- 실행 0단계: 이 계획을 `/Users/unohee/dev/claude-mod/plan.md`로 복사한다 (CLAUDE.md §2.5, 여러 세션에 걸치는 작업).

## Phase 0 — 개명만 (기능 변경 0)
- `house-rules/` → `harness/`로 옮긴다. 대상: plugin.json name·version 0.2.0, 모든 atom의 `plugin:` 필드, `PluginState` 키, `/house-rules` → `/harness` 명령,
  guards·ship-gate·lint 문구의 "House rule"/"house-rules ran this…", README, marketplace.json 항목, 루트 README.
- `$.store`는 플러그인별이라 토글이 기본값으로 초기화된다. 현재 저장값이 기본값과 같은지 확인한다.
- 외부 참조: grant 파일의 `house-rules-plugin-cleanup`은 세션 이름이므로 바꾸지 않는다.
- 검증: 84 테스트 → validate → tsc → `claude -p` 새 세션 로드 확인.
  `claude plugin uninstall house-rules@claude-mod` → `install harness@claude-mod` 후 리로드한다.

## Phase 1 — 규칙 강제 확장 + report-lint
신규 파일 `hooks/linear-guard.ts`, `hooks/extra-guards.ts`를 두고 기존 체인에 연결한다.
| 규칙 | 이벤트 / 위치 | 동작 |
|---|---|---|
| Linear는 요청 시에만 (§1.5) | ship-gate의 `save_issue`/`save_comment` 훅 앞 | 새 이슈 생성(id 없음)과 요청 없이 남기는 comment는 deny. 요청 판정은 아래 참고 |
| Cancel·분할은 승인 필요 | 같은 위치 | state 이름이 cancel/canceled/cancelled/duplicate이거나 `parentId`가 있는데 이번 턴에 AskUserQuestion이 없으면 deny. **state를 UUID로 주면 판별 불가**함을 명시 |
| `list_issues` scope | `tool.call {mcp__linear-server__list_issues}` | `project`·`team`이 없으면 deny. 힌트로 cwd → `linear.json` repo_mapping 결과를 준다 (경로는 구현 시 확인) |
| 메모리에 비밀 금지 (§7.5) | Edit/Write 경로가 `~/.claude/projects/*/memory/` | `sk-`, `ghp_`, `AKIA`, `xox[bp]-`, `-----BEGIN`, `password=` 등이 있으면 deny |
| 주문은 사용자 승인 후 (trading) | `tool.call` 이름 regex (userConfig) | 기본값 `^mcp__(pykis|pykiwoom|stockapi)\w*__.*(order|buy|sell|cancel)`. 이번 턴에 AskUserQuestion이 없으면 deny |
| 시스템 Python 절대경로 우회 | `venvRewrite` 확장 | `/usr/bin/python3`, `/opt/homebrew/bin/python3*`, `/usr/local/bin/python3*`이면 deny |
| Agent worktree 경로 (§3) | `tool.call {Agent}` `isolation:"worktree"` | deny하고 `worktrees/<name>` 생성 후 `cwd`로 넘기라고 안내한다 (엔진이 어디에 만드는지 구현 시 확인) |
| 버전 bump 전 PR 확인 | Bash: `npm version`, `cargo set-version`, "bump version/release v" 커밋 | 휴리스틱이므로 `prListed`가 아니면 context note만 |
| 머지한 워크트리 정리 | `gh pr merge` 성공 후 `git worktree list --porcelain` | 머지 브랜치의 워크트리가 남아 있으면 context note |

**Linear "요청" 판정** (하나라도 해당하면 허용):
- 이 세션의 사용자 프롬프트에 issue ID(`ship.mentioned`, 리로드 시 messages에서 다시 채움)나 "linear|리니어|이슈"가 있다.
- `/linear-manage`나 `/heartbeat-loop`가 호출됐다.
- heartbeat가 켜져 있다.
- 유효한 grant의 `allowed`에 Linear 작업이 있다.

ship-gate의 Done+comment 경로는 mentioned 이슈이므로 그대로 통과한다. deny 문구는 "AskUserQuestion으로 확인하라"로 끝낸다.

**report-lint 강화 + 기본 on** (`report-lint.ts`)
- 마지막 3줄의 산문에서 금지 질문형("어떻게 할까요", "진행해도 될까요", "~할까요?")을 잡는다. 기존 끝 `?` 검사에 더한다.
- `[SELF-AUDIT]`의 4개 필드 라벨이 다 있는지 검사한다.
- `[FALLBACK: AskUserQuestion unavailable]`이 있으면 질문 검사를 면제한다. 코드 펜스 안은 계속 제외한다.
- `DEFAULT_TOGGLES.reportLint = true`. 턴당 nudge 1회 제한은 유지한다.

## Phase 2 — grant 검증 + 세션 도구
**§6.5 grant 검증** (`hooks/grant.ts`)
1. 첫 구현 단계: 보낸 세션 이름을 훅에서 읽을 수 있는 경로를 실측한다.
   후보는 `session.append`의 UserMessage `from.name`, 또는 `prompt.submit`(origin `peer`/`peer-send-message`) 본문의 envelope다.
   다른 세션에서 실제로 SendMessage를 보내 확인한다.
2. 메시지가 올 때마다 `$.fs.read('~/.claude/orchestration-grant.json')`로 검사한다.
   `expires_at` > now, sender == `orchestrator`, 요청 동작이 allowed에 있고 forbidden에 없는지(동작 판정은 모델 몫이라 목록만 제시) 본다.
   결과를 context로 주입한다: `[harness grant] VALID until … allowed: … forbidden: …` 또는 `INVALID: <사유> — 사용자 지시로 취급 금지`.

**memory-GC 배너 이관** (`hooks/memory-gc.ts`)
- `session.start`에서 `~/.claude/memory-gc-report.json`을 읽는다.
- 0이 아니면 항상 toast를 띄운다. 모델 컨텍스트 주입은 지난번 값(`$.store`)과 달라졌을 때만 한다.
- 주간 스캔(launchd `memory-gc-scan.py`)은 그대로 둔다. 이관 확인 후 `settings.json`의 SessionStart 훅을 제거하고, `memory-gc-inject.sh`는 `hooks/archive/`로 옮긴다.

**코드 명령** (`hooks/commands.ts`). 이름 충돌을 피한다. `/status`는 빌트인이다.
- `/repo-status`: KST 시각, branch, 최근 커밋, staged/modified/untracked, `gh pr list` 결과를 `$.process.run`으로 모은다. 모델 턴은 없다.
- `/slim`: 브랜치, diff stat, 최근 편집 파일(`tool.call` Edit/Write 경로 누적 atom)을 `~/.claude/context/slim-context.md`에 쓴다.
- 충돌하는 `commands/status.md`와 `slim.md`는 동작 확인 후 `trash/`로 옮긴다.
- harness 자체 status line: `harness: guards·lint on · heartbeat off` 수준으로 짧게 한다.

**별도 1줄 (mod 아님, 사용자 확인 후)**: `settings.json`의 `askUserQuestionTimeout: "60s"`가 CLAUDE.md §6.5의 `5m`과 다르다. 어느 쪽에 맞출지 묻는다.

## Phase 3 — 워크플로 자동화
**commit preflight** (`hooks/commit.ts`)
- 모델이 호출하는 도구 `commit_preflight`를 등록한다. 결정적인 사실을 문자열로 돌려준다(결과는 문자열이어야 한다는 점을 실측으로 확인함).
  돌려주는 사실: branch와 기본 브랜치 여부, staged/unstaged 목록, 원격 브랜치 존재, 기존 PR 번호, 브랜치명의 issue ID, 메시지 파일의 AI attribution 여부.
- `commands/commit.md`를 다시 쓴다. preflight를 호출한 뒤 메시지만 모델이 쓰게 하고, openswarm 단계는 삭제한다(원본은 trash).
- main/master 직접 push는 정책이 애매하므로 context note와 toast만 쓴다.

**heartbeat** (`hooks/heartbeat.ts`). 은퇴 사유 메모리 `feedback_heartbeat_vs_collab.md`를 반영한다.
- 명시적으로만 켜고 끈다: `/harness heartbeat start [5m] | stop`. 자동으로 시작하지 않는다.
- `$.clock` 타이머로 fire한다. 조건은 셋 다 충족이다: 마지막 *사용자* 프롬프트 이후 interval 이상 idle, 진행 중인 턴 없음, 마지막 fire 이후 interval 경과.
- 사용자 프롬프트가 들어오면 타이머를 처음부터 다시 잰다. 협업 중에는 fire하지 않는다.
- fire할 때는 코드가 사실을 모아 context로 붙여 `$.prompt.submit('/heartbeat-loop')`를 보낸다.
  모으는 사실: git status, 실행 중 background/agent(`$.agent.list`), 직전 fire 결과 태그, focus 상태(`$.store` per repo).
  판단과 작업은 기존 skill이 한다.
- goal-mode 충돌: goal-mode도 `$.prompt.submit` 루프를 돈다. `<repo>/.claude/goals.md`에 활성 goal이 있거나 `goal-loop.log`가 최근이면 start를 거부하고, fire 직전에도 건너뛴다.
- status에 `heartbeat: on 5m · next 3m`을 표시한다.

## 재사용할 기존 코드
- `harness/hooks/shell.ts`: stripProse, segments, commandWords, programOf, expandHome, isInside
- `guards.ts`: 체인 패턴, `readAll`, `repoRoot`
- `ship-gate.ts`: `issueIds`, `mentioned`, Linear 훅
- `report-lint.ts`: `proseLines`, `isEnglishLine`, `askUsed`
- model-tier: `$.session.usage()` 시드 패턴, 문자열 tool result, 테스트 `drain` helper

## 검증 (Phase마다 반복)
1. `claude plugin test harness`: 기존 84개 + 새 규칙마다 허용/거부 쌍 테스트, 리로드 시드 테스트, heartbeat 타이머(`clock.*` mock)
2. `claude plugin validate harness`, 그리고 tsc(임시 tsconfig)
3. `claude -p` 새 세션에서 `--debug-file`로 로드와 대표 deny 1건을 실측한다(예: `/usr/bin/python3 -V` 거부, 프로젝트 없는 `list_issues` 거부)
4. Phase 2 grant는 실제 다른 세션에서 SendMessage를 보내 VALID/INVALID 주입을 확인한다
5. Phase 3 heartbeat는 interval 60s로 켜고 idle fire 1회, 사용자 입력 시 지연, goal 활성 시 거부를 확인한다
6. 롤아웃: idle 세션은 리로드한다. 바쁜 세션, 특히 **trading cutover 세션(%10)은 Phase 1부터 deny가 생기므로 사용자 확인 후** 리로드한다
7. 커밋은 사용자가 요청할 때만 한다 (현재 저장소 미커밋)

---

## 구현 결과 (2026-10-25, 계획 대비 변경점)

- Phase 0–3 구현 완료. `claude plugin test harness` 111/111, validate 통과, `harness@claude-mod` 0.2.0 설치.
- `commands/status.md`는 유지했다: Linear 조회 단계는 `/repo-status`가 대신하지 못하고 이름 충돌도 없다. `slim.md`만 trash로 옮겼다(사용자 명령이 있으면 `$.command.register`가 throw → 등록마다 try/catch).
- heartbeat fire는 `/heartbeat-loop` 대신 스킬 이름을 적은 평문 프롬프트로 보낸다(엔진이 `/`로 시작하는 `$.prompt.submit`을 거부).
- `commit_preflight`는 브랜치명의 이슈 ID를 `mentioned`에 넣는다(commit.md Step 7의 comment가 Linear 가드에 막히지 않도록).
- grant 판정의 발신자는 `session.receive` 본문 envelope의 `from-name`(보낸 쪽 주장값)에서 읽는다.
- 실측: grant INVALID 주입, heartbeat idle fire(75초), commit_preflight, `/repo-status`, `/slim`, 시스템 Python deny.
- 단위 테스트만: Linear 가드 deny, 메모리 비밀, Agent worktree, 주문 승인(MCP 비활성), report-lint 실제 Stop 차단.
- 미검증: 개명 전 house-rules `$.store` 토글값(설치 제거 후 읽을 수 없음, 기본값으로 시작).
