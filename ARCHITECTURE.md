# Agent Room 아키텍처 및 기능 상세 문서

이 문서는 세션 맥락을 놓친 에이전트나 새로 참여한 에이전트도 **코드 전체 구조·프로토콜·DB·UI·원격·배포 원리**를 바로 파악해 작업할 수 있도록 정리한 기술 기준서입니다.

> **유지보수 규칙:** 기능, API, DB 스키마, 제어 태그, 원격/알림/업데이트 동작을 추가·수정·삭제할 때는 **이 문서(`ARCHITECTURE.md`)도 같은 변경에서 함께 갱신**하세요.

---

## 1. 핵심 파일 맵

| 파일 | 역할 |
|---|---|
| `hub.cjs` | 로컬 허브 HTTP/WS 서버(`127.0.0.1:4317`), CLI 턴 실행·큐·조율·서브에이전트·한도·원격 직접 연결(`/api/room/direct`)·`cloudflared` 자동 터널 |
| `db.cjs` | SQLite(`local/rooms.db`) 초기화 및 스키마 마이그레이션 |
| `index.html` | PC 앱(WebView2) 및 로컬/직결 웹 UI, 설정 도우미 방 제안 카드, 모바일 UI(`.mobile-ui`) |
| `bridge.cjs` | 분리 프로세스로 CLI 턴 실행. **`hub.cjs`의 `runDetached()`가** 작업 JSON을 만들고 `bridge.cjs turn <job>`을 분리 실행한 뒤, 스풀(`local/spool`의 `job`·`result`·`pid`·`ack`·`interim`)에서 결과와 중간 출력을 읽는다. 허브가 재시작돼도 턴은 살아 있고 시작할 때 `recoverDetachedTurns`가 이어받는다. 프로세스가 사라진 채 약 3초(폴링 12회) 지나면 "에이전트 실행이 중단되어…" 오류로 처리 |
| `codex-app-server.cjs`, `codex-ipc.cjs`, `managed-codex.cjs` | Codex App Server IPC 및 관리형 Codex 세션 연동 |
| `limits.cjs` | Codex · Claude · Antigravity 사용량 한도 조회 및 `usage_limit` 초기화 시각 계산 |
| `handoff.cjs`, `node-mesh.cjs` | 작업 카드 생성/수락/거절/완료(테이블 `handoff_tasks`, `handoff_history`) 및 다중 PC 노드 메시 인계. 카드를 만들 때 같은 내용의 중복을 막는 장치가 없어 재시도가 겹치면 같은 카드가 여러 개 생길 수 있다(알려진 문제) |
| `remote-sync.cjs` | PC ↔ 원격 사이트(`/api/room/device`) 양방향 릴레이 데몬 |
| `cloudflare-setup.cjs` | 앱 내 원클릭 Cloudflare Workers + D1 자동 설정/배포/연결 검증 |
| `updater.cjs`, `update.ps1` | GitHub 릴리스 확인, ZIP 다운로드·무결성 검증·교체·롤백, 업데이트 진행 상태 판정 |
| `remote-site/handler.mjs` | 원격 사이트 API 핸들러 (`/api/room/device`, `/api/room/browser`, Web Push, 다중 노드 랑데부) |
| `remote-site/page.html` | Cloudflare Worker에서 서빙되는 원격 모바일/웹 UI (직결 자동 페일오버, 첨부, 한도, 푸시 구독) |
| `remote-site/cloudflare/worker.mjs` | Cloudflare Worker 엔트리 (비밀번호 쿠키 인증, `handleRoom` 위임, D1 이벤트 시 Web Push 발송) |
| `remote-site/cloudflare/push.mjs`, `push-payload.mjs` | VAPID 서명 및 RFC 8291(`aes128gcm`) Web Push 본문 암호화 |
| `remote-site/pwa.mjs`, `icons.mjs` | 원격 PWA `manifest.webmanifest`, `sw.js`, 아이콘 서빙 |
| `smoke-test.cjs`, `remote-site/smoke-test.mjs`, `cloudflare-setup-test.cjs` | 핵심 통합/회귀 스모크 테스트 |

---

## 2. SQLite 데이터베이스 (`db.cjs`, `local/rooms.db`)

- `rooms(id, name, memo, folder, work_mode, project)`: 방 목록. `work_mode`는 `'chat'` 또는 `'dev'`.
- `members(id, room, name, state, parent, paused, role, sub_kind, position)`: 참여자.
  - `state`: `'human' | 'pending' | 'starting' | 'start_failed' | 'approved' | 'disconnected'`
  - `parent`: 서브에이전트의 부모 ID. `sub_kind`: `'resident'`(상주형) 또는 `'task'`(일회성).
- `cli_sessions(member, project, thread, provider, model, effort, permission_profile, last_cli_error, policy_version, ...)`: CLI 세션 정보, 마지막 오류(`usage_limit`, `auth_expired` 등), 적용된 `policy_version`.
- `messages(seq, room, author, request, body, created, recipient, remote_source, relay_root, retracted)`:
  - `recipient`: 1인 지정(`[[TO:이름]]`) 대상.
  - `remote_source`: `'direct'`(PC 직접 연결) 또는 `'site'`(Site 경유).
  - `relay_root`: 원 요청 `seq`.
- `deliveries(seq, member, state, priority)`: 에이전트별 전달 상태(`queued`, `ranking`, `submitting`, `working`, `accepted`, `answered`, `context_only`, `context_seen`, `failed`, `coordination_wait`, `coordination_speaking`, `coordination_blocked`).
- `room_ranking(room, enabled, mode, main_member, judge_provider, judge_model, judge_effort, judge_prompt)`: 응답 모드(`broadcast` | `ranking` | `hierarchy`) 및 판정 설정.
- `reply_plans`, `coordination_turns`: 조율(`opinions`, `coordinating`, `ready`) 상태 및 라운드 순서.
- `remote_rooms(room, since)`, `remote_options`: 원격 공유 방 및 전체 자동 공유(`share_all`).
- `approval_rules`, `approval_logs`: 도구 실행 항상 허용 규칙 및 승인 로그.
- `handoff_tasks`, `handoff_history`: 작업 카드(id·owner·verifier·done_when·files·revision 등)와 그 변경 이력. 원격 Site(D1)에는 푸시용 `remote_push_key`(VAPID 서명 키), `remote_push_subscriptions`(구독)가 별도로 있다.
- `delivery_history`: **모든 메시지**에서 에이전트별 전달 상태가 바뀔 때마다 쌓이는 기록(대기 → 순위 판정 → 작업 중 …). 원격 메시지 전용이 아니다.
- `desktop_bindings`, `handoff_alerts`, `mesh_message_copy`: 데스크톱 바인딩, 작업 인계 알림, 다중 노드 메시지 동기화.

---

## 3. 에이전트 실행, 실시간 끼어들기, 제어 태그

### 3.1 턴 디스패치 및 끼어들기 (`hub.cjs`)
- `dispatchQueuedTurns()`가 `deliveries.state = 'queued'`를 모아 멤버별 실행.
- **작업 중(`cliBusy.has(participant)`) 끼어들기:**
  - `isAlert`와 `isCoordinated`가 아닌 일반 `priority >= 1` 메시지는 `deliverLive(participant, item)`를 호출합니다.
  - 세션이 `.steer` 또는 `.live` 인박스를 지원하면 진행 중인 턴으로 바로 끼어들어 전달되고, 미지원이면 `queued`로 남아 현재 턴 종료 후 실행됩니다.

### 3.1b 프롬프트 구조 · 순위 판정 · 조율 흐름
- 첫 턴이나 정책이 바뀐 턴에만 전체 정책(`replyPolicy`)을 보내고, 평소에는 짧은 규칙(`coreRules`)만 보낸다. 매 턴 붙는 상태 블록에는 에이전트별 모델·노력·우선순위와 한도가 들어가고, 요청은 `Current request` 머리글로 표시된다. 에이전트가 태그에 이름을 쓰면 `normalizeTagTargets`가 id로 바꾼다.
- 순위 판정 모델은 JSON을 내고 에이전트를 이름으로 가리킨다. 한도가 0%인 에이전트와 **이름이 불리지 않은 임시 작업자(`sub_kind='task'`)**는 후보에서 빠진다. 상주 서브에이전트는 기본으로 후보에 들어간다.
- `/조율 …`·`/회의 …`로 시작하는 메시지는 판정을 건너뛰고 "각자 의견 → 조율 → 동시 작업"(`/회의`는 합의안까지만)으로 간다. 이 표시(`flowBySeq`)는 **메모리에만** 있어서 허브가 재시작되면 판정 전이던 메시지는 일반 메시지로 처리된다.
- 자동 순위 방에서 "각자 의견 내고 다 나오면 상의해" 식의 한 메시지 요청은, 의견을 낸 에이전트가 2명 이상일 때만 조율 라운드로 넘어간다.
- 병렬 답변이 여러 개면 마지막에 답한 에이전트가 정리(`maybeWrapUp`)를 맡는다.
- 임시 작업자의 답은 부모에게만 가는 개인 메시지(`recipient`)이며 방에서는 접혀 보인다. 부모가 보고를 처리한 턴이 끝나면 작업자가 정리된다. 서브에이전트의 답은 부모만 1순위로 깨운다.

### 3.2 제어 태그 (에이전트 응답 본문에서 파싱)
- **위치 규칙:** 태그는 응답의 어느 줄에든 **그 줄에 태그만 단독으로** 있으면 인식한다(첫 줄일 필요 없음). 문장 중간에 섞인 태그, 인용문·코드 블록 속 태그는 무시한다.
- `[[WORK: 제목]]` / `[[DONE]]` / `[[CONTINUE]]` / `[[WAIT: 이유]]`: 작업 진행 상태 표시 및 연속 턴/대기 제어.
- `[[CALL:이름]]`: 후속 에이전트 호출.
- `[[TO:이름]]`: 해당 에이전트에게만 1:1 전달.
- `[[AFTER:이름]]`: 지정한 에이전트가 턴을 끝낼 때 깨움(`registerPeerWaiter` / `wakePeerWaiters`).
- `[[SPAWN:cli/model:name:task]]`: 현재 에이전트 아래 서브에이전트 생성(부모당 최대 3개).
- `[[DELEGATE:name|task|files|doneCriteria]]`: **자기 밑의 상주 서브에이전트**에게 작업 카드 생성 및 지시 전달. 다른 에이전트에게 일을 맡기려면 작업 카드에서 담당자를 지정한다(담당자를 깨우는 처리는 `handoff.change`의 `onCreate`).
- `[[AGENT_ROOM_NO_REPLY]]`: 응답이 불필요할 때 출력(방에 저장하지 않음).

### 3.3 정책 자동 동기화 (`policyHash`)
- `hub.cjs`의 `cliTurn`은 `replyPolicy` 문자열로 `policyHash`를 계산해 `cli_sessions.policy_version`과 비교합니다.
- 정책 문구가 바뀌면 기존 세션에도 `(Room policy updated; it replaces the earlier one.)`와 함께 전체 `replyPolicy`를 자동 재전송합니다.

### 3.4 사용량 한도(`usage_limit`) 처리 및 경고
- `cliTurn`에서 `error.cliCode === 'usage_limit'` 발생 시 `recordQuotaLimit()`으로 쿨다운 시각을 기록하고 `last_cli_error`를 갱신합니다.
- 기존 경고가 없을 때(`!limitNotified.has(participant)` 및 직전 `last_cli_error`가 `usage_limit`이 아닐 때)만 채팅방에 경고 메시지를 1회 남기고, 정상 턴 완료 시 `limitNotified`를 초기화합니다.

---

## 4. 설정 도우미 방 (`index.html`, `hub.cjs`)

- 우측 하단 `💬` 버튼 또는 `Alt+클릭`(터치 길게 누르기)은 `assistant_room` 액션을 호출해 대화 모드(`work_mode='chat'`)의 **"설정 도우미"** 방을 엽니다.
- 방 공통 지침(`memo`)은 💬를 누를 때마다 `ensureAssistantRoom()`이 새로 만든다(앱 사용법 + 허용 동작 목록 + 상태 요약 1300자, 전체 3990자 이내). 방 설정 창에서 지침을 저장하면 맨 앞 표시가 지워져 카드가 안 뜰 수 있으니, 그땐 💬를 다시 누르면 복구된다. 상태 요약은 방을 열 때 찍은 것이라 오래 대화했다면 💬로 갱신한다.
- 방 공통 지침(`memo`) 맨 앞의 `ASSISTANT_ROOM_MARK` (`'[설정 도우미 방]'`)로 식별합니다. (`index.html`에서 `ASSISTANT_ROOM_MARK`와 `isAssistantRoom`은 초기화 순서 오류(TDZ) 방지를 위해 `<script>` 상단에 선언합니다.)
- 도우미 에이전트 응답의 ```` ```agent-room-action {...}``` ```` 블록은 `splitAssistantActions()`가 허용 목록(`create`, `rename_room`, `set_work_mode`, `new_agent`, `apply_update`, `cloudflare_setup_start`, `report_issue` 등)만 파싱해 `[실행]`/`[취소]` 카드로 렌더링합니다.
- **허용 목록은 두 곳에 있다:** `hub.cjs`의 `ASSISTANT_ACTIONS`(+`report_issue`)와 `index.html`의 `splitAssistantActions`. 동작을 추가할 때 둘을 함께 고쳐야 한다. 전체: `create`, `rename_room`, `set_work_mode`, `room_memo`, `room_ranking`, `new_agent`, `edit_agent`, `pause_agent`, `disconnect`, `login_cli`, `retry_agent`, `refresh_limits`, `remote_share`, `check_update`, `apply_update`, `cloudflare_setup_start`, `report_issue`.
- `report_issue` 카드는 `assistant_issue_url`로 개인정보를 가린 GitHub 새 이슈 주소를 받아 새 탭을 연다. 예전 팝업용 `assistant_ask`·`assistant_config`·`assistant_reset`은 서버에 남아 있지만 화면은 쓰지 않는다. 카드 실행 결과는 `localStorage`(`agentRoomAssistantDone`)에 저장돼 새로고침해도 버튼이 되살아나지 않는다.

---

## 5. 원격 접속, 직결 터널, Cloudflare 자동 설정, Web Push

### 5.1 두 가지 원격 경로 (`remote-sync.cjs`, `hub.cjs`, `remote-site/`)
1. **Site 경유 (`remote-sync.cjs` ↔ Worker `/api/room/device` ↔ 브라우저 `/api/room/browser`):**
   - `remote-sync.cjs`가 `local/hub.json`(url·token)으로 로컬 허브 `/state`를 읽어 Site `/api/room/device`에 `{rooms, acknowledged, snapshot, events}`를 POST하고, 응답의 `commands`를 `http://127.0.0.1:4317/tool`(`remote_user_message`, `remote_control`)로 전달합니다. 전달이 끝난 명령 ID는 다음 요청의 `acknowledged`로 알립니다. 허브 쪽은 요청 ID(`remote:<id>`)로 중복을 걸러 재시도해도 두 번 저장되지 않습니다.
   - **주기:** 에이전트가 일하는 중이거나 보낼 내용이 있으면 2초, 한가하면 5초. 변경이 없어도 하트비트를 15초마다(폰이 직결 중이면 60초마다) 보내고, 폰이 최근 30초 안에 직결로 붙어 있으면 상태 전용 업로드를 건너뛰는 "조용한 모드"가 된다. 실패하면 2→최대 30초로 늘려 재시도한다. 한 번에 메시지 35개·약 1.4MB까지, 메시지당 본문 30000자까지이며 **개인 메시지(`recipient`)는 올리지 않는다.**
   - **주소 고정:** 중계는 `hub.json`의 주소가 정확히 `http://127.0.0.1:4317`이 아니면 거부한다. `ROOM_PORT`를 바꾸면 원격 중계가 멈춘다.
   - **요청 본문 제한은 경로마다 다르다:** PC 웹 UI의 `/control` 12 MiB, `/tool`·`/delivery` 64 KiB, 원격 웹의 `/api/room/direct` 1,500,000바이트. Base64로 인코딩된 크기가 기준이라, Site에는 접수된 첨부가 PC의 `/tool` 전달 단계에서 413으로 실패할 수 있다.
   - **안정성:** 중계 시작 실패(`spawn` 오류)와 비정상 종료는 허브가 간격을 늘려 가며 재시작하고, 손상된 `remote-cursor.json`은 무시하고 시작한다. 허브가 죽어 중계만 남으면 새 허브가 `remote-alive.json`/프로세스 검색으로 이전 중계를 정리한다.
   - 허브 오류는 `local/hub-errors.log`에 기록되고(`uncaughtException`·`unhandledRejection`은 기록 후 계속 실행, 포트 충돌·DB 손상은 종료), `local/hub.json`은 임시 파일 후 교체 방식으로 써서 읽는 쪽이 반쯤 쓰인 파일을 보지 않는다.
2. **PC 직접 연결 (`/api/room/direct` + `cloudflared` 자동 터널):**
   - `hub.cjs`의 `startDirectTunnel()`이 직접 모드 활성 시 `local/cloudflared.exe`(또는 기본 설치 경로)를 백그라운드 실행해 `https://*.trycloudflare.com` 주소를 얻고, `listDirectUrls()`에서 최우선(`priority: -1`)으로 `directLinks`에 실어 보냅니다.
   - `remote-site/page.html`의 `roomRequest()`는 `directLinks`로 직접 요청을 먼저 시도하고, 실패/타임아웃 시 `/api/room/browser`로 자동 폴백합니다.
   - **직결 복구 순서:** 알려진 후보를 차례로 시도하고, 모두 실패하면 조회 요청에서만 Site `snapshot.directLinks`를 한 번 읽어 새 주소를 즉시 시험한다(`navigator.connection` 변경도 감지). 메시지 전송은 같은 요청 ID로 Site에 넘겨 중복 저장을 막는다. **상단 배지는 현재 연결 경로**, **말풍선의 경로 표시는 그 메시지를 PC에 처음 저장한 경로**다.
   - 직결 파일 다운로드는 `GET /local-file?path=…`(프로젝트 폴더 안의 파일만). 직결 사전 확인(preflight) 응답에는 사설 네트워크 접근 허용 헤더가 들어가고, Bearer로 출처 검사를 건너뛰는 것은 Worker가 실제로 인증을 확인했을 때(`BEARER_VERIFIED`)만 허용된다.
   - 제어 요청 결과를 확인하기 위해 임시로 Site 조회만 수행할 때(`siteForControl = controlRequests.size > 0`)는 상단 연결 배지를 Site 경유로 덮어쓰지 않고 툴팁(`conn.title`)에만 표시합니다.

### 5.2 Cloudflare Workers + D1 원클릭 자동 설정 (`cloudflare-setup.cjs`)
- `npx wrangler@4`로 OAuth 로그인 후 Cloudflare API(`/client/v4`)를 통해 계정 선택 → `workers.dev` 서브도메인 확인 또는 `agent-room-<12hex>` 자동 등록 → D1 DB(`agent-room-db`) 생성 및 `schema.sql`~`0007_web_push_payload.sql` 적용 → Worker 업로드(`worker.mjs`, `handler.mjs`, `page.html`, `pwa.mjs`, `icons.mjs`, `push.mjs`, `push-payload.mjs`) → 실제 인증·DB 응답 확인 후 `remote-config.json` 전환.

### 5.3 백그라운드 Web Push (`remote-site/cloudflare/push.mjs`, `push-payload.mjs`)
- `0005_web_push.sql`, `0007_web_push_payload.sql`로 브라우저 구독(`endpoint`, `p256dh`, `auth`)을 D1에 저장합니다.
- **발송 대상:** 새로 저장된 에이전트 답변만. 중간 출력·시스템 메시지·중복 수신은 제외한다. VAPID 서명 키는 구독과 별개로 D1 `remote_push_key`에 저장된다.
- **검증 범위:** 암호화·복호화 왕복과 배포된 서비스 워커 코드는 확인했다. **앱을 닫은 실제 휴대폰에서의 수신은 아직 미검증.**
- Worker가 PC에서 올라온 새 에이전트 답변 이벤트를 받으면 `encryptPushPayload(payload, p256dh, auth)`(RFC 8291 `aes128gcm`)로 에이전트 이름과 미리보기를 암호화해 VAPID 서명과 함께 푸시를 발송합니다.

---

## 6. UI · 모바일 · 업데이트

- **키보드 스크롤 보정 (`syncPhoneHeight`):** `index.html`과 `remote-site/page.html` 모두 `visualViewport.height`가 줄어들고 입력창(`#draft`)에 포커스가 있을 때만 메시지 목록(`#messages` / `#history`)의 `scrollTop`을 `delta`만큼 올립니다.
- **스크롤 두 가지:** 키보드가 올라올 때는 보고 있던 위치를 화면 높이 변화만큼 보정하고, 새 원격 메시지가 오면 열려 있는 대화의 맨 아래로 이동한다. PC에서 검색 중이거나 폰에서 이전 기록을 더 불러오는 중에는 읽던 위치를 유지한다. 두 동작은 따로 검증한다.
- **인라인 `<script>`가 2개:** `index.html`에는 메인 스크립트 위에 독립된 크래시 복구·`uiStamp` 자동 새로고침 스크립트가 하나 더 있다. 검사할 때는 `matchAll`로 **모두** 검사한다.
- **모바일 채팅 한도 텍스트:** 모바일에서는 에이전트 카드 대신 채팅 메시지 보낸이 이름 옆에 해당 모델의 남은 한도 텍스트를 표시합니다.
- **업데이트 (`updater.cjs`, `update.ps1`):** `local/update.log`의 인코딩(UTF-8 / EUC-KR 폴백)과 마지막 상태 줄을 `readUpdateStatus()`가 판정해 진행 중·PC 재연결 대기·새 버전 실행 확인 완료·실패를 상단 배너와 설정 창에 표시합니다.
- **업데이트 흐름:** `shutdown_for_update`는 에이전트가 일하는 중이어도 바로 허브를 재시작한다(이미 재시작 중일 때만 409). 진행 중이던 턴은 재시작 뒤 `recoverWarmTurns`·`recoverDetachedTurns`가 다시 대기열에 넣고, 대기 중이던 순위 판정은 다시 돌며, 새 메시지는 outbox에서 기다린다. `update.ps1`은 SHA-256 검증 → 임시 폴더(`agent-room-update-*`)에 백업 → 파일 교체 → 새 허브 응답 확인 순으로 가고, 실패하면 백업으로 롤백한다.
- **업데이트 도중 전원 꺼짐 복구:** 파일을 바꾸기 직전 `update.ps1`이 `local/update-in-progress.json`(백업 위치·파일 목록·업데이터 PID)을 만들고, 성공 또는 롤백이 끝나면 지운다. 허브가 시작할 때 이 파일이 남아 있고 업데이터가 죽어 있으면 `recoverInterruptedUpdate()`가 백업에서 파일을 복원하고 허브를 다시 띄운다(`AGENT_ROOM_NO_UPDATE_RECOVERY`가 있으면 건너뜀). 백업이 이미 지워졌으면 표시 파일만 지운다.

---

## 7. 변경 후 검증 체크리스트

수정한 영역에 따라 아래 명령으로 검증합니다:
- JS 문법 검사: `node --check hub.cjs` (수정한 `.cjs` / `.mjs` 대상)
- 인라인 스크립트 검사: `index.html`(스크립트 2개), `remote-site/page.html`의 **모든** `<script>`를 `matchAll`로 추출해 각각 `new Function(code)`
- 허브 통합 테스트: `node smoke-test.cjs` (1~2분 걸린다. 짧은 제한 시간으로 돌리면 실패처럼 보일 수 있다)
- 원격 릴레이/다중 노드 테스트: `node remote-site/smoke-test.mjs`
- Cloudflare 자동 설정 테스트: `node cloudflare-setup-test.cjs`

### 릴리스 · 배포 주의
- 릴리스 명령은 `E:\agentroomfolder\release.ps1 -Version X -Commit HEAD`. VERSION·CHANGELOG 갱신과 커밋을 먼저 해 둔다.
- **새 파일을 추가하면 `release.ps1`의 `$files` 목록에도 넣는다.** 빠지면 릴리스 ZIP에서 누락된다. (`update.ps1`은 ZIP 안의 파일을 모두 설치하므로 목록은 `release.ps1` 쪽이 기준이다.)
- 원격 페이지·Worker를 바꿨다면 새 버전 설치 뒤 Cloudflare 자동 설정을 다시 실행해 Worker를 재배포해야 폰에 반영된다. 수동 `wrangler deploy`를 쓴다면 `wrangler.toml` 기본 이름(`agent-room-remote`)이 아니라 `local/remote-config.json`의 `site` 호스트명(`agent-room-<12hex>`)으로 `--name`을 지정한다.
