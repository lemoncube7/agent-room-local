# 원격 접속, 직결 터널, Cloudflare 자동 설정, Web Push

## 5.1 두 가지 원격 경로 (`remote-sync.cjs`, `hub.cjs`, `remote-site/`)
1. **Site 경유 (`remote-sync.cjs` ↔ Worker `/api/room/device` ↔ 브라우저 `/api/room/browser`):**
   - `remote-sync.cjs`가 `local/hub.json`(url·token)으로 로컬 허브 `/state`를 읽어 Site `/api/room/device`에 `{rooms, acknowledged, snapshot, events}`를 POST하고, 응답의 `commands`를 `http://127.0.0.1:4317/tool`(`remote_user_message`, `remote_control`)로 전달합니다. 전달이 끝난 명령 ID는 다음 요청의 `acknowledged`로 알립니다. 허브 쪽은 요청 ID(`remote:<id>`)로 중복을 걸러 재시도해도 두 번 저장되지 않습니다.
   - **주기:** 에이전트가 일하는 중이거나 보낼 내용이 있으면 2초, 한가하면 5초. 변경이 없어도 하트비트를 15초마다(폰이 직결 중이면 60초마다) 보내고, 폰이 최근 30초 안에 직결로 붙어 있으면 상태 전용 업로드를 건너뛰는 "조용한 모드"가 된다. 실패하면 2→최대 30초로 늘려 재시도한다. 한 번에 메시지 35개·약 1.4MB까지, 메시지당 본문 30000자까지이며 **개인 메시지(`recipient`)는 올리지 않는다.**
   - **주소 검사:** 중계는 `hub.json`의 주소가 `http://127.0.0.1:<포트>` 모양(루프백 호스트, 어떤 포트든)이 아니면 거부한다. 허브가 4317을 못 쓰면 다른 포트로 옮겨 가므로 포트는 고정하지 않는다. 호스트가 루프백이 아니면 토큰을 보내기 전에 거부한다.
   - **포트 규칙(허브):** 기본 4317. 명시한 `ROOM_PORT`는 그대로 쓰고 막혀 있으면 실패한다. 4317을 다른 프로그램이 쓰고 있으면 4318~4337, 그래도 없으면 OS가 고른 포트로 옮기고, 같은 데이터를 쓰는 두 번째 허브를 막으려고 **점유자가 Agent Room 허브이면 새 허브를 띄우지 않고 조용히 종료**한다. 시작·런처·설정 스크립트·중계는 모두 `local/hub.json`의 주소를 읽는다(없으면 4317). 테스트용 환경 변수: `AGENT_ROOM_DEFAULT_PORT`, `AGENT_ROOM_NO_BACKGROUND=1`.
   - **요청 본문 제한은 경로마다 다르다:** PC 웹 UI의 `/control` 12 MiB, 원격 직결 `/api/room/direct` 12 MiB, `/tool`은 기본 64 KiB를 유지하되 `remote-sync.cjs`가 `remote_user_message`에 붙이는 `x-agent-room-remote-message: 1` 헤더가 있을 때만 12 MiB를 허용한다(Base64 인코딩 포함 최대 8 MiB 파일 수용). 원격 UI(`remote-site/page.html`)는 전송 전 경로별 가능 크기(직결 최대 8MB, Site 경유 D1 단일 행 제한 권장 ~700KB)를 안내하고, Site에만 접수된 메시지는 `Site 접수 · PC 저장 대기` 말풍선으로 표시한 뒤 PC 저장이 확인되면 `PC 저장됨`으로 전환한다.
   - **안정성:** 중계 시작 실패(`spawn` 오류)와 비정상 종료는 허브가 간격을 늘려 가며 재시작하고, 손상된 `remote-cursor.json`은 무시하고 시작한다. 허브가 죽어 중계만 남으면 새 허브가 `remote-alive.json`/프로세스 검색으로 이전 중계를 정리한다.
   - 허브 오류는 `local/hub-errors.log`에 기록되고(`uncaughtException`·`unhandledRejection`은 기록 후 계속 실행, 포트 충돌·DB 손상은 종료), `local/hub.json`은 임시 파일 후 교체 방식으로 써서 읽는 쪽이 반쯤 쓰인 파일을 보지 않는다.
2. **PC 직접 연결 (`/api/room/direct` + `cloudflared` 자동 터널):**
   - `hub.cjs`의 `startDirectTunnel()`이 직접 모드 활성 시 `local/cloudflared.exe`(또는 기본 설치 경로)를 백그라운드 실행해 `https://*.trycloudflare.com` 주소를 얻고, `listDirectUrls()`에서 최우선(`priority: -1`)으로 `directLinks`에 실어 보냅니다.
   - `remote-site/page.html`의 `roomRequest()`는 `directLinks`로 직접 요청을 먼저 시도하고, 실패/타임아웃 시 `/api/room/browser`로 자동 폴백합니다.
   - **직결 복구 순서:** 알려진 후보를 차례로 시도하고, 모두 실패하면 조회 요청에서만 Site `snapshot.directLinks`를 한 번 읽어 새 주소를 즉시 시험한다(`navigator.connection` 변경도 감지). 메시지 전송은 같은 요청 ID로 Site에 넘겨 중복 저장을 막는다. **상단 배지는 현재 연결 경로**, **말풍선의 경로 표시는 그 메시지를 PC에 처음 저장한 경로**다.
   - 직결 파일 다운로드는 `GET /local-file?path=…`(프로젝트 폴더 안의 파일만). 직결 사전 확인(preflight) 응답에는 사설 네트워크 접근 허용 헤더가 들어가고, Bearer로 출처 검사를 건너뛰는 것은 Worker가 실제로 인증을 확인했을 때(`BEARER_VERIFIED`)만 허용된다.
   - 제어 요청 결과를 확인하기 위해 임시로 Site 조회만 수행할 때(`siteForControl = controlRequests.size > 0`)는 상단 연결 배지를 Site 경유로 덮어쓰지 않고 툴팁(`conn.title`)에만 표시합니다.

- **직결을 먼저 시도하고 Site를 예비 경로로 둡니다.** PC에 닿으면 채팅을 허브에서 바로 읽고 보낼 수 있고, 휴대폰 네트워크가 바뀌거나 PC에 닿지 않을 때는 Site가 요청을 받아 PC에 전달할 수 있습니다. 읽기 요청은 Site에서 새 직결 주소를 받아 즉시 시험할 수 있지만, 전송 중에는 이미 PC에 저장됐을 수 있으므로 같은 요청 ID로 재시도합니다.
- **현재 연결과 메시지가 도착한 경로를 따로 표시합니다.** 설정 결과를 확인하느라 Site를 잠깐 조회해도 채팅 경로가 바뀐 것처럼 보여서는 안 됩니다. 메시지의 경로는 PC에 처음 저장된 시점에 확정해, 직결 응답이 끊긴 뒤 Site로 재시도해도 전달 이력을 추적할 수 있게 합니다.

## 5.2 Cloudflare Workers + D1 원클릭 자동 설정 (`cloudflare-setup.cjs`)
- `npx wrangler@4`로 OAuth 로그인 후 Cloudflare API(`/client/v4`)를 통해 계정 선택 → `workers.dev` 서브도메인 확인 또는 `agent-room-<12hex>` 자동 등록 → D1 DB(`agent-room-db`) 생성 및 `schema.sql`~`0007_web_push_payload.sql` 적용 → Worker 업로드(`worker.mjs`, `handler.mjs`, `page.html`, `pwa.mjs`, `icons.mjs`, `push.mjs`, `push-payload.mjs`) → 실제 인증·DB 응답 확인 후 `remote-config.json` 전환.

## 5.3 백그라운드 Web Push (`remote-site/cloudflare/push.mjs`, `push-payload.mjs`)
- **설계 의도:** 사용자가 앱을 열어 두지 않아도 새 답변을 알 수 있고, 알림에서 누가 답했는지와 답변 앞부분을 확인할 수 있어야 한다. 이를 위해 Worker가 브라우저의 푸시 구독으로 제목과 미리보기를 보내며, 내용은 구독별 키로 암호화한다. 암호화는 푸시 전달 경로에 평문 답변을 싣지 않기 위한 것이며, 사용자 기기의 알림 화면에는 미리보기가 표시된다.
- `0005_web_push.sql`, `0007_web_push_payload.sql`로 브라우저 구독(`endpoint`, `p256dh`, `auth`)을 D1에 저장합니다.
- **발송 대상:** 새로 저장된 에이전트 답변만. 중간 출력·시스템 메시지·중복 수신은 제외한다. VAPID 서명 키는 구독과 별개로 D1 `remote_push_key`에 저장된다.
- **검증 범위:** 암호화·복호화 왕복과 배포된 서비스 워커 코드는 확인했다. **앱을 닫은 실제 휴대폰에서의 수신은 아직 미검증.**
- Worker가 PC에서 올라온 새 에이전트 답변 이벤트를 받으면 `encryptPushPayload(payload, p256dh, auth)`(RFC 8291 `aes128gcm`)로 에이전트 이름과 미리보기를 암호화해 VAPID 서명과 함께 푸시를 발송합니다.

## 설계 의도 (왜 이렇게 했나)

- **직결 링크 자동 등록 (오퍼스):** 사이트 주소가 바뀌면 휴대폰 브라우저에 저장된 직결 링크가 사라져 계속 "Site 경유"가 됐다. 사용자가 직접 붙여넣지 않게, 직결 주소와 키를 비밀번호로 보호된 본인 Worker를 거쳐 전달하는 것을 감수했다.
- **Bearer 우회는 Worker가 검증했을 때만 (오퍼스):** ChatGPT Sites 경로에서는 인증 헤더가 검증되지 않으므로 출처 검사 우회를 막았다.
- **휴대폰이 직결 중이면 중계는 조용히 (오퍼스):** Site는 예비 경로라 상태만 바뀐 업로드를 줄인다. 새 메시지는 바로 올린다.
- **Worker가 PWA 파일을 직접 제공 (오퍼스):** ChatGPT Site에서 Worker로 옮기며 manifest·sw·아이콘이 빠져 "설치할 수 없음"이 됐던 사고 때문.
- **원격 첨부 본문 한도 및 무한 대기 방지 (수소):** `remote-site`(25MB)·`saveAttachments`(8MB)와 달리 허브 `/tool`(64KB)·`/api/room/direct`(1.5MB) 제한이 작으면 첨부 전달이 413으로 거절되고, 구형 원격 UI가 `controlResults`의 `kind:'message'` 오류를 못 받아 무한 `PC 전달 대기`에 걸렸다. 원격 UI가 실패를 바로 띄우게 한 부분은 반영됐다. **`/tool`·`/api/room/direct` 한도를 12MB로 맞추는 것은 아직 코드에 없다**(2026-11-28 확인: `/tool` 64KiB, `/api/room/direct` 1,500,000바이트). (오퍼스 검토)

- **ChatGPT Sites 폐기 → Cloudflare Workers + PC 직접 연결 2트랙:** ChatGPT Sites는 배포 권한 제약과 호스팅 의존성이 커서, 사용자 소유 무료 Cloudflare Workers + D1(PC 꺼짐 백업·안내소)과 PC 직접 연결(실시간·대용량) 조합으로 일원화했다.
- **`cloudflared` 자동 터널 + `directLinks` 자동 교환:** 기숙사/공용 Wi-Fi의 클라이언트 격리(AP Isolation), 5G↔Wi-Fi 전환, HTTPS→HTTP Mixed Content 차단 때문에 사설 LAN IP만으로는 직결이 불안정하다. 유료 도메인(Named Tunnel) 없이도 영구 직결처럼 쓰기 위해, 허브가 임시 터널을 자동 실행·재시작해 `directLinks` 최우선(`priority: -1`)으로 올리고, 폰(`roomRequest`)은 직결 실패 시 즉시 Site에서 새 주소를 받아 재시도한다.
- **직결 전용 파일 다운로드 (`GET /local-file`):** 모바일 브라우저에서는 `file://` 링크가 차단되고 파일도 PC에 있으므로, `localhost`는 PC에서 열기를 유지하되 외부 직결에서는 프로젝트 폴더 내부 파일에 한해 안전하게 다운로드 전송한다.
- **멀티 노드 안내소(Rendezvous) & 호스트 선출 (`0004_multi_node.sql`, `node-mesh.cjs`):** 여러 PC와 사용자가 한 방을 쓸 때 Cloudflare 요청·D1 용량 한도를 피하기 위해, 호스팅은 현재 `hubUrl`·`lease` 안내와 전원 오프라인 시 임시 대기열만 맡고 실제 트래픽은 선출된 온라인 PC 1대가 처리하며, 허브 PC가 꺼지면 다른 온라인 PC가 `epoch + 1`로 자동 승계하도록 설계했다.

- **중계가 `hub.json` 주소를 루프백 호스트로만 받는 이유:** 이 파일에는 허브 토큰이 들어 있다. 주소가 엉뚱한 호스트면 토큰이 밖으로 나갈 수 있어서 `127.0.0.1`만 허용한다. 예전에는 포트까지 4317로 고정했는데, 4317이 다른 프로그램에 점유된 PC에서 허브가 시작하지 못하는 문제가 있어 포트는 풀고 호스트 검사만 남겼다.
- **점유자가 Agent Room 허브면 종료하는 이유:** 같은 `local` 데이터(DB·스풀)를 두 허브가 동시에 쓰면 메시지가 두 번 배달되거나 DB가 깨질 수 있다. 예전에는 포트 충돌이 우연히 이 잠금 역할을 했으므로, 포트를 옮기는 기능을 넣으면서 점유자 확인을 명시적으로 넣었다.
- **손상된 `remote-cursor.json`을 무시하고 시작하는 이유:** 전원이 갑자기 꺼지면 이 파일이 깨질 수 있고, 그러면 중계가 영영 못 켜져 원격이 먹통이 된다. 최악의 경우(커서를 잃음)에는 이미 올린 메시지를 다시 올릴 수 있지만, 원격이 멈추는 것보다 낫다고 판단했다.
- **중계 재시작에 간격을 늘리는 이유:** 시작 실패나 반복 종료가 계속될 때 CPU와 네트워크를 낭비하지 않으려고 2초에서 최대 60초까지 늘린다. 한 번 시작해 60초 넘게 살아 있었다면 간격을 다시 2초로 되돌린다.
- **허브가 죽어도 남은 중계를 새 허브가 정리하는 이유:** 허브가 갑자기 죽으면 자식 프로세스인 중계가 고아로 남을 수 있다. 중복 중계가 같은 메시지를 두 번 보내는 것을 막으려고, 새 허브는 시작할 때 `remote-alive.json`과 프로세스 검색으로 이전 중계를 먼저 종료한다.

> 상위 목차: [ARCHITECTURE.md](../../ARCHITECTURE.md)
