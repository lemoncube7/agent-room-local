# 원격 접속, 직결 터널, Cloudflare 자동 설정, Web Push

## 5.1 두 가지 원격 경로 (`remote-sync.cjs`, `hub.cjs`, `remote-site/`)
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

## 5.2 Cloudflare Workers + D1 원클릭 자동 설정 (`cloudflare-setup.cjs`)
- `npx wrangler@4`로 OAuth 로그인 후 Cloudflare API(`/client/v4`)를 통해 계정 선택 → `workers.dev` 서브도메인 확인 또는 `agent-room-<12hex>` 자동 등록 → D1 DB(`agent-room-db`) 생성 및 `schema.sql`~`0007_web_push_payload.sql` 적용 → Worker 업로드(`worker.mjs`, `handler.mjs`, `page.html`, `pwa.mjs`, `icons.mjs`, `push.mjs`, `push-payload.mjs`) → 실제 인증·DB 응답 확인 후 `remote-config.json` 전환.

## 5.3 백그라운드 Web Push (`remote-site/cloudflare/push.mjs`, `push-payload.mjs`)
- `0005_web_push.sql`, `0007_web_push_payload.sql`로 브라우저 구독(`endpoint`, `p256dh`, `auth`)을 D1에 저장합니다.
- **발송 대상:** 새로 저장된 에이전트 답변만. 중간 출력·시스템 메시지·중복 수신은 제외한다. VAPID 서명 키는 구독과 별개로 D1 `remote_push_key`에 저장된다.
- **검증 범위:** 암호화·복호화 왕복과 배포된 서비스 워커 코드는 확인했다. **앱을 닫은 실제 휴대폰에서의 수신은 아직 미검증.**
- Worker가 PC에서 올라온 새 에이전트 답변 이벤트를 받으면 `encryptPushPayload(payload, p256dh, auth)`(RFC 8291 `aes128gcm`)로 에이전트 이름과 미리보기를 암호화해 VAPID 서명과 함께 푸시를 발송합니다.

> 상위 목차: [ARCHITECTURE.md](../../ARCHITECTURE.md)
