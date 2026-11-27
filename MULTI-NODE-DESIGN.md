# Agent Room Multi-Node & Multi-User Architecture (Design Draft)

하나의 Room에 **여러 사용자**와 **여러 PC(실행 노드)**를 연결하되, 호스팅 서버는 **초기 연결·탐색(Rendezvous/Signaling)**만 돕고 실제 허브 역할은 **온라인 PC 중 1대가 동적으로 선출·승계(Host Election & Migration)**하는 분산 구조 설계서입니다.

---

## 1. 핵심 목표
1. **호스팅 비용·한도 최소화:** Cloudflare Workers + D1은 방 탐색, 현재 허브 주소(`hubUrl`), 하트비트(Lease) 관리만 담당하고, 실제 채팅·SSE 푸시·대용량 파일·에이전트 조율은 선출된 **허브 PC**가 직접 처리.
2. **멀티 PC 분산 협업:** 집 데스크톱, 노트북, Mac, 리눅스 서버가 한 방에 참여해 각 PC의 로컬 에이전트(`네온 @집PC`, `솔 @맥북`)가 자기 머신에서 병렬 작업.
3. **멀티 유저 협업 + PC 보안 격리:** 여러 사용자가 같은 방에서 대화·협업하되, **남의 PC에서 임의 명령 실행(`DEV`)은 해당 PC 주인의 승인 또는 허용 목록**을 통해서만 가능.
4. **무중단 승계 (Host Migration):** 허브 PC가 꺼지면 다른 온라인 PC가 로컬 미러 DB로 즉시 허브를 이어받고, 모든 PC가 꺼졌을 때만 호스팅이 임시 오프라인 대기열(읽기 + 예약 전송) 수행.

---

## 2. 역할 구조 (3-Tier)

| 계층 | 역할 | 실행 위치 |
|---|---|---|
| **1. Rendezvous (안내소)** | 방 목록, 현재 허브 `hubUrl` + `leaseExpiresAt`, 참여자/노드 등록, 오프라인 임시 대기열 | Cloudflare Workers + D1 |
| **2. Elected Hub (선출된 허브)** | 방의 실시간 Source of Truth (`seq` 발급, SSE `/events`, 파일 업로드, 판정·조율) | 외부 접속이 열린 온라인 PC 중 1대 |
| **3. Worker Node / Client** | 자기 로컬 에이전트 실행 (`node_id` 담당 턴만 수신), 로그 미러링 / 폰·브라우저 접속 | 나머지 PC / 사용자 기기 |

---

## 3. 허브 선출 및 승계 (Host Election & Migration)

### 3.1 선출 규칙
외부 접속 가능한 URL(Tailscale Funnel, Cloudflare Tunnel, 직접 서버 등)을 보고한 온라인 PC(`canHost = true`) 중에서 선택:
- **규칙 모드 (기본):** `priority`(메인 PC 가중치) → `uptime`(가장 오래 켜진 PC) → `nodeId` 사전순
- **랜덤 모드 (선택):** `canHost = true` 후보 중 무작위 1대 선출

### 3.2 하트비트 & Lease
- 현재 허브 PC는 10초마다 안내소(Worker)에 `POST /api/rendezvous/heartbeat` 전송 (`leaseTtl = 25s`).
- `leaseExpiresAt`이 지나면 안내소는 허브를 `expired`로 표시하고, 다음 하트비트/조회 시 살아 있는 다른 `canHost` PC를 새 허브로 선출(`epoch + 1`).

### 3.3 로그 미러링 & 승계
- 모든 참여 PC 노드는 허브의 SSE(`/events`)를 구독하며 방의 `messages`와 `members`를 자기 로컬 SQLite에 복제(`lastSeq`).
- 새 허브로 선출된 PC는 `epoch`를 올리고 자기 `lastSeq`부터 이어서 서비스를 시작.
- 다른 PC 노드와 폰 클라이언트는 허브 연결이 끊기면 안내소(`GET /api/rendezvous/room/:id`)를 1회 조회해 새 `hubUrl`로 자동 재연결.
- **모든 PC가 오프라인일 때:** 안내소가 `mode: "offline_queue"`를 반환하고, 사용자가 보낸 메시지를 D1 대기열에 임시 보관 → 아무 PC나 켜져 새 허브가 되면 대기열을 흡수(`drain`).

---

## 4. 멀티 PC 에이전트 라우팅
- 각 에이전트 멤버에 `node_id`와 `node_label`(예: `집PC`, `맥북`)을 부여.
- 방 로스터 및 UI에는 `네온 4 @집PC`, `솔 6.2 @맥북` 형태로 표시.
- 허브의 판정·조율 로직은 기존과 동일하게 `deliveries`를 생성하되, **각 PC 노드는 `member.node_id === myNodeId`인 `queued` 턴만** 가져가 자기 로컬 CLI로 실행하고 결과를 허브에 `POST /api/node/reply`로 제출.

---

## 5. 파일 및 코드 동기화 (직접 통신 + Git/GitHub 하이브리드)
이전 허브 PC가 꺼진 뒤 다른 PC가 새 허브로 승계할 때, **방 대화·상태**는 안내소/로컬 미러로 이어받을 수 있지만 **꺼진 PC에 있는 프로젝트 파일**은 직접 통신만으로 받기 어렵습니다. 따라서 데이터 성격에 따라 역할을 나눕니다:
- **프로젝트 소스 코드 → Git + GitHub:**
  - 각 방에 연결된 Git 원격 저장소(GitHub 등)를 코드의 영구 원본으로 사용.
  - PC 노드가 작업을 마치면 작업 브랜치(예: `agent-room/<node_id>` 또는 `main`)에 커밋·푸시하고, 새 PC/새 허브가 참여·승계할 때 `git pull`로 최신 코드를 즉시 동기화.
- **채팅 첨부 파일(이미지·로그·문서) → 허브 직접 통신:**
  - 허브 PC의 `local/uploads/`로 직접 HTTP 업로드/다운로드(D1 용량 제한 회피).
  - 필요 시 온라인 참여 PC 간 백그라운드 캐시 복제.

---

## 6. 멀티 유저 & PC별 실행 권한 (보안)
- 사용자 계정: `user_id`, `display_name`, 방 역할(`owner` / `member` / `guest`).
- **PC별 실행 정책 (`local/node-policy.json`):**
  - `ownerOnly` (기본값): 내 PC 에이전트의 `DEV` 모드(파일 수정·명령 실행)는 **내 `user_id`가 보낸 요청**만 자동 허용. 다른 사용자가 내 PC 에이전트에게 작업을 요청하면 `chat`(읽기 전용)으로 제한하거나 내 PC/폰에 **승인 카드**를 띄움.
  - `trustedUsers`: 허용 목록에 등록된 팀원 `user_id`는 내 PC에서도 `DEV` 실행 허용.

---

## 7. 단계별 구현 로드맵

### Phase 1 — 1인 멀티 PC + 허브 선출 MVP
- [ ] `remote-site/cloudflare/worker.mjs`에 `rendezvous` 테이블 및 엔드포인트 추가:
  - `POST /api/rendezvous/register` (노드 등록: `nodeId`, `label`, `publicUrl`, `canHost`)
  - `POST /api/rendezvous/heartbeat` (허브 Lease 연장 및 승계 판정)
  - `GET /api/rendezvous/room/:id` (현재 `hubUrl`, `epoch`, `nodes[]`, `offlineMode` 반환)
- [ ] `hub.cjs`에 `node` 모드 추가: 자기가 허브가 아니면 `hubUrl`에 SSE로 붙어 자기 `node_id` 턴만 실행 + 로컬 SQLite 미러링.
- [ ] `index.html` / PWA에 `hubUrl` 자동 전환(허브 변경 시 재연결) 적용.

### Phase 2 — 멀티 유저 초대 & PC별 권한
- [ ] 방 초대 링크/코드 발급 및 사용자별 닉네임·토큰(`user_id`) 구분.
- [ ] 말풍선 작성자 표시를 `나` 고정에서 실제 `user.display_name`으로 확장.
- [ ] `local/node-policy.json` 기반 타인 요청 `DEV` 승인 카드 연동.
