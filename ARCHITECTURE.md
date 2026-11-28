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
| `bridge.cjs` | 분리 프로세스(`runDetached`)로 CLI 턴 실행 및 결과 스풀(`local/spool`) 기록 |
| `codex-app-server.cjs`, `codex-ipc.cjs`, `managed-codex.cjs` | Codex App Server IPC 및 관리형 Codex 세션 연동 |
| `limits.cjs` | Codex · Claude · Antigravity 사용량 한도 조회 및 `usage_limit` 초기화 시각 계산 |
| `handoff.cjs`, `node-mesh.cjs` | 작업 카드(`tasks`) 생성/수락/거절/완료 및 다중 PC 노드 메시 인계 |
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
- `desktop_bindings`, `handoff_alerts`, `delivery_history`, `mesh_message_copy`: 데스크톱 바인딩, 작업 인계 알림, 원격 전달 이력, 다중 노드 메시지 동기화.

---

## 3. 에이전트 실행, 실시간 끼어들기, 제어 태그

### 3.1 턴 디스패치 및 끼어들기 (`hub.cjs`)
- `dispatchQueuedTurns()`가 `deliveries.state = 'queued'`를 모아 멤버별 실행.
- **작업 중(`cliBusy.has(participant)`) 끼어들기:**
  - `isAlert`와 `isCoordinated`가 아닌 일반 `priority >= 1` 메시지는 `deliverLive(participant, item)`를 호출합니다.
  - 세션이 `.steer` 또는 `.live` 인박스를 지원하면 진행 중인 턴으로 바로 끼어들어 전달되고, 미지원이면 `queued`로 남아 현재 턴 종료 후 실행됩니다.

### 3.2 제어 태그 (에이전트 응답 본문에서 파싱)
- `[[WORK: 제목]]` / `[[DONE]]` / `[[CONTINUE]]` / `[[WAIT: 이유]]`: 작업 진행 상태 표시 및 연속 턴/대기 제어.
- `[[CALL:이름]]`: 후속 에이전트 호출.
- `[[TO:이름]]`: 해당 에이전트에게만 1:1 전달.
- `[[AFTER:이름]]`: 지정한 에이전트가 턴을 끝낼 때 깨움(`registerPeerWaiter` / `wakePeerWaiters`).
- `[[SPAWN:cli/model:name:task]]`: 현재 에이전트 아래 서브에이전트 생성(부모당 최대 3개).
- `[[DELEGATE:name|task|files|doneCriteria]]`: 상주 서브에이전트에게 작업 카드 생성 및 지시 전달.
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
- 방 공통 지침(`memo`) 맨 앞의 `ASSISTANT_ROOM_MARK` (`'[설정 도우미 방]'`)로 식별합니다. (`index.html`에서 `ASSISTANT_ROOM_MARK`와 `isAssistantRoom`은 초기화 순서 오류(TDZ) 방지를 위해 `<script>` 상단에 선언합니다.)
- 도우미 에이전트 응답의 ```` ```agent-room-action {...}``` ```` 블록은 `splitAssistantActions()`가 허용 목록(`create`, `rename_room`, `set_work_mode`, `new_agent`, `apply_update`, `cloudflare_setup_start`, `report_issue` 등)만 파싱해 `[실행]`/`[취소]` 카드로 렌더링합니다.

---

## 5. 원격 접속, 직결 터널, Cloudflare 자동 설정, Web Push

### 5.1 두 가지 원격 경로 (`remote-sync.cjs`, `hub.cjs`, `remote-site/`)
1. **Site 경유 (`remote-sync.cjs` ↔ Worker `/api/room/device` ↔ 브라우저 `/api/room/browser`):**
   - `remote-sync.cjs`가 `local/hub.json`으로 로컬 허브 `/state`를 읽어 2~5초 주기로 `remote_events`, `remote_rooms`, `remote_state` 스냅샷을 업로드하고 `remote_commands`를 가져와 `http://127.0.0.1:4317/tool` (`remote_user_message`, `remote_control`)로 전달합니다.
   - `hub.cjs`의 `/tool`과 `/api/room/direct` 본문 제한은 첨부 파일(최대 8MB, base64 포함)을 수용하기 위해 `12 * 1024 * 1024`(12MB)로 설정되어 있습니다.
2. **PC 직접 연결 (`/api/room/direct` + `cloudflared` 자동 터널):**
   - `hub.cjs`의 `startDirectTunnel()`이 직접 모드 활성 시 `local/cloudflared.exe`(또는 기본 설치 경로)를 백그라운드 실행해 `https://*.trycloudflare.com` 주소를 얻고, `listDirectUrls()`에서 최우선(`priority: -1`)으로 `directLinks`에 실어 보냅니다.
   - `remote-site/page.html`의 `roomRequest()`는 `directLinks`로 직접 요청을 먼저 시도하고, 실패/타임아웃 시 `/api/room/browser`로 자동 폴백합니다.
   - 제어 요청 결과를 확인하기 위해 임시로 Site 조회만 수행할 때(`siteForControl = controlRequests.size > 0`)는 상단 연결 배지를 Site 경유로 덮어쓰지 않고 툴팁(`conn.title`)에만 표시합니다.

### 5.2 Cloudflare Workers + D1 원클릭 자동 설정 (`cloudflare-setup.cjs`)
- `npx wrangler@4`로 OAuth 로그인 후 Cloudflare API(`/client/v4`)를 통해 계정 선택 → `workers.dev` 서브도메인 확인 또는 `agent-room-<12hex>` 자동 등록 → D1 DB(`agent-room-db`) 생성 및 `schema.sql`~`0007_web_push_payload.sql` 적용 → Worker 업로드(`worker.mjs`, `handler.mjs`, `page.html`, `pwa.mjs`, `icons.mjs`, `push.mjs`, `push-payload.mjs`) → 실제 인증·DB 응답 확인 후 `remote-config.json` 전환.

### 5.3 백그라운드 Web Push (`remote-site/cloudflare/push.mjs`, `push-payload.mjs`)
- `0005_web_push.sql`, `0007_web_push_payload.sql`로 브라우저 구독(`endpoint`, `p256dh`, `auth`)을 D1에 저장합니다.
- Worker가 PC에서 올라온 새 에이전트 답변 이벤트를 받으면 `encryptPushPayload(payload, p256dh, auth)`(RFC 8291 `aes128gcm`)로 에이전트 이름과 미리보기를 암호화해 VAPID 서명과 함께 푸시를 발송합니다.

---

## 6. UI · 모바일 · 업데이트

- **키보드 스크롤 보정 (`syncPhoneHeight`):** `index.html`과 `remote-site/page.html` 모두 `visualViewport.height`가 줄어들고 입력창(`#draft`)에 포커스가 있을 때만 메시지 목록(`#messages` / `#history`)의 `scrollTop`을 `delta`만큼 올립니다.
- **모바일 채팅 한도 텍스트:** 모바일에서는 에이전트 카드 대신 채팅 메시지 보낸이 이름 옆에 해당 모델의 남은 한도 텍스트를 표시합니다.
- **업데이트 (`updater.cjs`, `update.ps1`):** `local/update.log`의 인코딩(UTF-8 / EUC-KR 폴백)과 마지막 상태 줄을 `readUpdateStatus()`가 판정해 진행 중·PC 재연결 대기·새 버전 실행 확인 완료·실패를 상단 배너와 설정 창에 표시합니다.

---

## 7. 변경 후 검증 체크리스트

수정한 영역에 따라 아래 명령으로 검증합니다:
- JS 문법 검사: `node --check hub.cjs` (수정한 `.cjs` / `.mjs` 대상)
- 인라인 스크립트 검사: `index.html`, `remote-site/page.html`의 `<script>` 추출 후 `new Function(code)`
- 허브 통합 테스트: `node smoke-test.cjs`
- 원격 릴레이/다중 노드 테스트: `node remote-site/smoke-test.mjs`
- Cloudflare 자동 설정 테스트: `node cloudflare-setup-test.cjs`
