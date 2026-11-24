# Agent Room

Windows PC에서 **Codex CLI**, **Claude Code**, **Antigravity (`agy`)** 에이전트들이 하나의 공용 채팅방에 모여 협업하는 로컬 멀티 에이전트 허브입니다.

## 주요 기능

- **멀티 CLI 통합 협업:** Codex, Claude Code, Antigravity 에이전트를 한 방에 추가하고 역할을 지정해 동시에 또는 순차적으로 협업합니다.
- **3가지 방 구조 모드 (`⋯` → `방 구조 모드 설정`):**
  - **자유 · 동시 응답:** 방의 모든 활성 에이전트에게 동시에 전달
  - **자동 · 순위 판정:** 판단 CLI(Codex / Claude / Antigravity)가 대상·작업 상태·구독 잔여량·초기화 시각을 보고 `0`/`1`순위를 배정 (사용자 수동 지침 입력 및 `1순위로 깨우기` 지원)
  - **계층형 · 메인 → 하위:** 사용자 메시지가 메인 에이전트에게 먼저 전달되며, 메인 에이전트가 `[[FORWARD:id]]`로 다른 에이전트에게 바로 위임 가능
- **권한 승인 카드 & 안전장치:** Claude Code와 Antigravity(`agy acp`)의 미허용 명령은 PC 앱과 원격 UI에서 `거부` / `이번만 허용` / `항상 허용`으로 제어할 수 있습니다.
- **작업 현황판 & 구독 잔여량:** 에이전트별 현재 작업 단계, 동시 파일 수정 충돌 경고, 5시간/7일 잔여량 및 초기화 시각을 실시간으로 확인합니다.
- **방 편의 기능:** 방 공유 메모(고정 컨텍스트), 작업 인계(`handoff`), 에이전트 일시정지/재개, 내 메시지 철회, 외부 세션 대화코드 전송(`bridge.cjs say --code`), 완료/승인 알림, 앱 내 프로젝트 전환.
- **원격 접속:** 소유자 비공개 ChatGPT Site와 연동해 외부에서도 방 확인, 메시지 전송, 허용 응답, 구조 모드 변경이 가능합니다. ([원격 연결 안내](REMOTE-SETUP.md))

---

## 사전 준비

1. **Node.js 24 이상** 설치
2. 사용할 CLI 중 하나 이상 설치 및 로그인 (`codex`, `claude`, `agy`)
   - 설치 상태 사전 점검: `powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 -Check`

---

## Windows에서 시작하기

1. GitHub Releases에서 Windows ZIP을 받아 원하는 폴더(예: `E:\Agent-Room`)에 압축을 풉니다.
2. **`Start Agent Room.cmd`**를 실행합니다.
3. 한국어 런처에서 작업할 프로젝트 폴더를 선택하고 **시작**을 누르면 허브가 켜지고 전용 앱 창(Edge/Chrome `--app` 모드)으로 열립니다.
4. 방을 만들고 오른쪽 위 `⋯` 메뉴 → **에이전트 추가** 또는 **기존 대화 연결 코드 만들기**로 에이전트를 연결하세요.

### 외부 세션에서 단발 메시지 보내기
오른쪽 위 `⋯` → **외부 메시지 코드 만들기**에서 10분짜리 대화코드를 발급받아 실행할 수 있습니다.

```powershell
node bridge.cjs say --code <대화코드> "보낼 메시지" --as "외부 세션" --wake
```

---

## LLM에게 설치 맡기기

저장소 링크와 함께 아래처럼 요청할 수 있습니다.

> 이 README대로 Agent Room을 현재 작업 프로젝트에 설치해 줘. 내 기존 Codex·Claude 대화는 유지해. CLI 실행과 프로젝트 MCP 등록, 테스트 결과를 각각 알려 줘.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Project 'E:\my-project' -Test
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Project 'E:\my-project' -Apply -Connect -Test
```

같은 프로젝트에서 다시 실행해도 MCP 등록이 중복되지 않으며, 기존 다른 설정이 있으면 덮어쓰지 않습니다.

---

## 업데이트 · 검증 · 보안

- **자동 업데이트:** 앱 왼쪽 사이드바의 **업데이트 확인** → **업데이트 설치**를 누르면 `local/` 데이터는 유지한 채 앱 파일만 교체하고, 실패 시 이전 버전으로 자동 복구합니다.
- **통합 테스트:** `node smoke-test.cjs` 및 `node remote-site/smoke-test.mjs`
- **데이터·보안·백업·제거·문제 신고:** [SECURITY.md](SECURITY.md) 참고
- **라이선스:** [MIT License](LICENSE)
- **원격 연결 및 개발 인계:** [REMOTE-SETUP.md](REMOTE-SETUP.md), [HANDOFF.md](HANDOFF.md)
