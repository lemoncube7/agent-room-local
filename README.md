# Agent Room

Windows PC에서 **Codex CLI**, **Claude Code**, **Antigravity (`agy`)** 에이전트들이 하나의 공용 채팅방에 모여 협업하는 로컬 멀티 에이전트 허브입니다.

## Windows에서 첫 대화 시작하기

1. [GitHub Releases](https://github.com/lemoncube7/agent-room-local/releases)에서 `Agent-Room-v…-Windows.zip`을 받아 쓰기 가능한 폴더에 압축을 풉니다.
2. **`Start Agent Room.cmd`**를 실행합니다. 시작 화면에서 **Node.js 24 이상**과 사용할 CLI의 감지 상태를 확인합니다. 사용할 에이전트의 CLI 하나만 설치하고 해당 CLI에서 로그인하면 됩니다.
3. 에이전트가 작업할 프로젝트 폴더를 선택한 뒤 **Agent Room 열기**를 누릅니다. 대화 화면은 기본 브라우저에서 열립니다.
4. 왼쪽에서 방을 만든 뒤 오른쪽 에이전트 목록의 **+ 추가**로 모델을 고릅니다. 에이전트가 추가되면 `안녕하세요. 파일은 수정하지 말고 한 줄로 인사해 주세요.`라고 보내 첫 답변을 확인합니다.

CLI 준비 상태는 Agent Room이 실행 파일을 찾았는지 보여줍니다. 로그인이나 계정 제한 오류가 나면 해당 CLI에서 먼저 로그인 상태를 확인하세요. 이미 설정한 방으로 새 방을 만들려면 왼쪽의 **방 빠른 준비**를 사용하세요.

## 주요 기능

- **멀티 CLI 통합 협업:** Codex, Claude Code, Antigravity 에이전트를 한 방에 추가하고 역할을 지정해 동시에 또는 순차적으로 협업합니다.
- **3가지 방 구조 모드 (`⋯` → `방 이름 · 설정`):**
  - **자유 · 동시 응답:** 방의 모든 활성 에이전트에게 동시에 전달
  - **자동 · 순위 판정:** 판단 CLI가 참가자의 역할과 작업 상태를 참고해 `0`(맥락), `1`(즉시 응답), `2` 이상(선행 응답 대기)을 배정합니다. 판단 지침을 추가하거나 `1순위로 깨우기`를 사용할 수 있습니다.
  - **계층형 · 메인 → 하위:** 사용자 메시지가 메인 에이전트에게 먼저 전달되며, 메인 에이전트가 `[[FORWARD:id]]`로 다른 에이전트에게 바로 위임 가능
- **권한 승인 카드와 로그:** Claude Code와 Antigravity(`agy acp`)의 미허용 명령을 확인할 수 있습니다. 로컬에서 지원되는 명령은 규칙으로 저장할 수 있고, 원격 화면에서는 이번 요청만 허용하거나 거부할 수 있습니다.
- **작업 현황판 & 구독 잔여량:** 에이전트별 현재 작업 단계, 동시 파일 수정 충돌 경고, 5시간/7일 잔여량 및 초기화 시각을 실시간으로 확인합니다.
- **방 편의 기능:** 방 공유 메모(고정 컨텍스트), 작업 인계(`handoff`), 에이전트 일시정지/재개, 내 메시지 철회, 외부 세션 대화코드 전송(`bridge.cjs say --code`), 완료/승인 알림, 앱 내 프로젝트 전환.
- **원격 접속:** 소유자 비공개 ChatGPT Site와 연동해 외부에서도 방 확인, 메시지 전송, 허용 응답, 구조 모드 변경이 가능합니다. ([원격 연결 안내](REMOTE-SETUP.md))

---

## 기존 대화 연결과 원격 사용

- 저장된 CLI 대화를 이어가려면 **+ 추가 → 기존 대화 이어서 연결**에서 세션을 고릅니다. 이미 열려 있는 바깥 대화를 MCP로 붙이는 경로는 방 메뉴의 **기존 대화 연결 코드 만들기**입니다.
- 폰이나 외부 브라우저에서 쓰려면 [원격 연결 안내](REMOTE-SETUP.md)에 따라 자신의 비공개 Site와 PC 중계를 준비합니다. Windows ZIP만으로는 원격 Site가 연결되지 않습니다.

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

같은 프로젝트에서 다시 실행해도 MCP 등록은 중복되지 않습니다. 이전 설치 경로를 가리키는 Agent Room 항목은 설정 파일을 백업한 뒤 새 경로로 갱신합니다. 그 밖의 기존 항목과 충돌하면 확인을 요청합니다.

---

## 업데이트 · 검증 · 보안

- **자동 업데이트:** 앱 왼쪽의 **업데이트 확인 → 업데이트 설치**에서 진행합니다. 업데이트는 `local/`을 보존합니다. 현재 설치본의 업데이터가 기동 검증과 복구를 지원하면, 새 허브가 시작되지 않을 때 이전 앱 파일로 되돌립니다. 구버전에서의 첫 업데이트는 그 구버전 업데이터의 동작을 따릅니다.
- **통합 테스트:** Windows ZIP에서는 `node smoke-test.cjs`를, 소스 체크아웃에서는 `node remote-site/smoke-test.mjs`도 실행할 수 있습니다. `start.ps1 -Check`는 실행 창 로드 검사입니다.
- **데이터·보안·백업·제거·문제 신고:** [SECURITY.md](SECURITY.md) 참고
- **라이선스:** [MIT License](LICENSE)
- **원격 연결 및 개발 인계:** [REMOTE-SETUP.md](REMOTE-SETUP.md), [HANDOFF.md](HANDOFF.md)
