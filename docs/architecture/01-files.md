# 핵심 파일 맵

| 파일 | 역할 |
|---|---|
| `hub.cjs` | 로컬 허브 HTTP/WS 서버(기본 `127.0.0.1:4317`, 포트가 막혀 있으면 다른 포트. 실제 주소는 `local/hub.json`), CLI 턴 실행·큐·조율·서브에이전트·한도·원격 직접 연결(`/api/room/direct`)·`cloudflared` 자동 터널 |
| `db.cjs` | SQLite(`local/rooms.db`) 초기화 및 스키마 마이그레이션 |
| `index.html` | PC 앱(WebView2) 및 로컬/직결 웹 UI, 설정 도우미 방 제안 카드, 모바일 UI(`.mobile-ui`) |
| `bridge.cjs` | 분리 프로세스로 CLI 턴 실행. **`hub.cjs`의 `runDetached()`가** 작업 JSON을 만들고 `bridge.cjs turn <job>`을 분리 실행한 뒤, 스풀(`local/spool`의 `job`·`result`·`pid`·`ack`·`interim`)에서 결과와 중간 출력을 읽는다. 허브가 재시작돼도 턴은 살아 있고 시작할 때 `recoverDetachedTurns`가 이어받는다. 프로세스가 사라진 채 약 3초(폴링 12회) 지나면 "에이전트 실행이 중단되어…" 오류로 처리 |
| `codex-app-server.cjs`, `codex-ipc.cjs`, `managed-codex.cjs` | Codex App Server IPC 및 관리형 Codex 세션 연동 |
| `limits.cjs` | Codex · Claude · Antigravity 사용량 한도 조회 및 `usage_limit` 초기화 시각 계산 |
| `handoff.cjs`, `node-mesh.cjs` | 작업 카드 생성/수락/거절/완료(테이블 `handoff_tasks`, `handoff_history`) 및 다중 PC 노드 메시 인계. 같은 방에 제목·할 일·담당자·범위·완료 기준이 같은 미완료 카드가 있으면 새로 만들지 않고 기존 카드를 돌려준다(`duplicate:true`) |
| `remote-sync.cjs` | PC ↔ 원격 사이트(`/api/room/device`) 양방향 릴레이 데몬 |
| `cloudflare-setup.cjs` | 앱 내 원클릭 Cloudflare Workers + D1 자동 설정/배포/연결 검증 |
| `updater.cjs`, `update.ps1` | GitHub 릴리스 확인, ZIP 다운로드·무결성 검증·교체·롤백, 업데이트 진행 상태 판정 |
| `remote-site/handler.mjs` | 원격 사이트 API 핸들러 (`/api/room/device`, `/api/room/browser`, Web Push, 다중 노드 랑데부) |
| `remote-site/page.html` | Cloudflare Worker에서 서빙되는 원격 모바일/웹 UI (직결 자동 페일오버, 첨부, 한도, 푸시 구독) |
| `remote-site/cloudflare/worker.mjs` | Cloudflare Worker 엔트리 (비밀번호 쿠키 인증, `handleRoom` 위임, D1 이벤트 시 Web Push 발송) |
| `remote-site/cloudflare/push.mjs`, `push-payload.mjs` | VAPID 서명 및 RFC 8291(`aes128gcm`) Web Push 본문 암호화 |
| `remote-site/pwa.mjs`, `icons.mjs` | 원격 PWA `manifest.webmanifest`, `sw.js`, 아이콘 서빙 |
| `smoke-test.cjs`, `remote-site/smoke-test.mjs`, `cloudflare-setup-test.cjs` | 핵심 통합/회귀 스모크 테스트 |

> 상위 목차: [ARCHITECTURE.md](../../ARCHITECTURE.md)
