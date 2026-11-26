# Agent Room

Windows PC에서 **Codex CLI**, **Claude Code**, **Antigravity (`agy`)** 에이전트들이 하나의 공용 채팅방에 모여 협업하는 로컬 멀티 에이전트 허브입니다.

**원격 연결 작업을 맡은 GPT/Codex는 [원격 연결 실행 절차](REMOTE-SETUP.md#원격-연결-작업을-맡은-gptcodex)를 먼저 읽고 따라갑니다.** 설치와 기존 연결 상태를 확인한 뒤 비공개 Site 준비, PC 연결, 테스트 메시지 왕복까지 접근 가능한 환경에서 진행합니다.

## Windows에서 첫 대화 시작하기

1. [GitHub Releases](https://github.com/lemoncube7/agent-room-local/releases)에서 `Agent-Room-v…-Windows.zip`을 받아 쓰기 가능한 폴더에 압축을 풉니다.
2. **`Agent Room.exe`**(또는 `Start Agent Room.cmd`)를 실행합니다. 시작 화면에서 **Node.js 24 이상**과 사용할 CLI의 감지 상태를 확인합니다. `Agent Room.exe`는 작업 표시줄·시작 메뉴·바탕화면에 바로 고정할 수 있습니다. 사용할 에이전트의 CLI 하나만 설치하고 해당 CLI에서 로그인하면 됩니다.
   - *참고:* `Agent Room.exe`에는 별도 코드 서명이 없어 Windows SmartScreen 경고가 뜰 수 있습니다(**추가 정보 → 실행**). 원하시면 포함된 `launcher.cs`와 `build-exe.ps1`로 직접 빌드하거나, `Start Agent Room.cmd` / `start.ps1`로 바로 실행해도 동일합니다.
3. 에이전트가 작업할 프로젝트 폴더를 선택한 뒤 **Agent Room 열기**를 누릅니다. 대화 화면은 **전용 앱 창(WebView2)** 또는 기본 브라우저에서 열립니다(**⚙ 설정**에서 전환 가능).
4. 왼쪽에서 방을 만든 뒤 오른쪽 에이전트 목록의 **+ 추가**로 모델을 고릅니다. 에이전트가 추가되면 `안녕하세요. 파일은 수정하지 말고 한 줄로 인사해 주세요.`라고 보내 첫 답변을 확인합니다.

CLI 준비 상태는 Agent Room이 실행 파일을 찾았는지 보여줍니다. 로그인이나 계정 제한 오류가 나면 해당 CLI에서 먼저 로그인 상태를 확인하세요. 이미 설정한 방으로 새 방을 만들려면 왼쪽의 **방 빠른 준비**를 사용하세요.

## 주요 기능

- **멀티 CLI 통합 협업:** Codex, Claude Code, Antigravity 에이전트를 한 방에 추가하고 역할을 지정해 동시에 또는 순차적으로 협업합니다.
- **3가지 방 구조 모드 (`⋯` 방 설정):**
  - **자유 · 동시 응답:** 방의 모든 활성 에이전트에게 동시에 전달
  - **자동 · 순위 판정:** 판단 CLI가 참가자의 역할과 작업 상태를 참고해 `0`(맥락), `1`(즉시 응답), `2` 이상(선행 응답 대기)을 배정합니다. 판단 지침을 추가하거나 `1순위로 깨우기`를 사용할 수 있습니다.
  - **계층형 · 메인 → 하위:** 사용자 메시지가 메인 에이전트에게 먼저 전달되며, 메인 에이전트가 `[[FORWARD:id]]`로 다른 에이전트에게 바로 위임 가능
- **권한 승인 카드와 로그:** Claude Code와 Antigravity(`agy acp`)의 미허용 명령을 현재 방에 요약 표시하며, 승인 로그(**⚙ 설정 → 권한 승인 로그**)와 `항상 허용` 규칙 개별 삭제를 지원합니다.
- **작업 현황판 & 실시간 작업 칩:** 입력창 바로 위에 작업 중인 에이전트별 칩(진행 단계·경과 시간)이 표시되며 클릭 시 상세 출력을 바로 엽니다. 오른쪽 패널에서는 에이전트 카드 드래그 순서 변경, 일시정지 시각화, 간결히 보기, 5h/7d 잔여량·사용속도를 확인합니다.
- **크로스-CLI 서브에이전트:** 에이전트 카드 `⋯` 메뉴의 `+ 서브 추가`나 `[[SPAWN:provider[/model]:이름:지시]]`로 다른 CLI 서브에이전트를 부모 아래에 바로 붙여 협업할 수 있습니다.
- **방·앱 편의 기능:** 헤더 원클릭 **`대화 모드` ↔ `개발 모드`** 전환, 방 전체 검색(`Ctrl+F`), 왼쪽 방 목록 `⋯` 메뉴(탐색기 작업 폴더 선택·그룹 이름·삭제), **⚙ 설정**(다크/블랙/라이트 테마·앱 창/브라우저 전환·원격 연결·완료 알림·업데이트 확인·캐시 무시 새로고침), 방 프리셋·공통 지침, 내 메시지 철회, 로컬 파일 링크 바로 열기.
- **원격 접속:** **⚙ 설정 → 원격 연결**에서 비공개 ChatGPT Site 또는 독립 Cloudflare Workers 서버 주소와 키를 저장해 허브 시작 시 자동 연결할 수 있습니다. ([원격 연결 안내](REMOTE-SETUP.md))

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

## 설치·설정을 맡은 GPT/Codex

사용자가 설치나 초기 설정을 요청하면 아래 절차를 실행한다. 요청 범위에 맞춰 기존 설치와 데이터를 재사용하고, 성공한 동작까지 확인해 보고한다.

1. 접근 가능한 Windows PC에서 기존 설치의 `VERSION`과 `local/`, 현재 작업 프로젝트, Node.js 24 이상, 사용할 CLI를 확인한다. 신규 설치라면 [GitHub Releases](https://github.com/lemoncube7/agent-room-local/releases)의 Windows ZIP과 함께 제공되는 SHA-256을 확인한 뒤 쓰기 가능한 폴더에 푼다. 기존 설치 업데이트는 앱의 업데이트 경로를 사용한다.
2. 아래 두 번째 명령의 프로젝트 경로를 실제 경로로 바꿔 설치 폴더에서 실행한다. 첫 번째 명령은 설정을 적용하기 전에 검사만 요청받은 경우에 사용한다. 기존 대화와 `local/`을 보존하고, 전역 MCP 등록이나 프로젝트 신뢰 추가는 사용자가 요청한 경우에만 수행한다.
3. 첫 방 준비까지 요청받았으면 기존 방과 에이전트를 확인해 재사용한다. 필요한 경우 아래 허브 API로 새 방과 에이전트를 만들고, 파일 수정 없는 짧은 테스트 메시지와 에이전트의 실제 답변을 확인한다. 기존 대화를 연결해 달라는 요청은 **+ 추가 → 기존 대화 이어서 연결**에서 대상 세션을 확인한 뒤 진행한다.
4. 원격 연결 요청은 [원격 연결 실행 절차](REMOTE-SETUP.md#원격-연결-작업을-맡은-gptcodex)를 따른다. Windows 접근이나 CLI 로그인이 필요한 경우에는 완료한 단계와 사용자에게 필요한 동작을 알린다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Project 'E:\my-project' -Test
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Project 'E:\my-project' -Apply -SelectProject -Connect -Test
```

- `-SelectProject`를 넣으면 `local/project.txt`에 기본 프로젝트가 저장되어 앱을 열 때 프로젝트 선택 창을 건너뜁니다. 전역 MCP까지 함께 등록하려면 `-Global`을 추가합니다.
- **네이티브 앱 창 준비:** `setup.ps1` 출력의 `native_window`에서 `Agent Room.exe`·`webview2/` SDK·WebView2 런타임 준비 여부를 확인할 수 있습니다. 런타임이 없으면 `winget install --id Microsoft.EdgeWebView2Runtime --silent`로 설치하고, 실행 방식은 `-OpenMode window` 또는 `-OpenMode browser`로 지정할 수 있습니다.
- **설정 파일 위치:** Codex는 프로젝트의 `.codex/config.toml`, Claude Code는 `.mcp.json`, 앱 상태·선택된 프로젝트는 `local/` 폴더에 저장됩니다. Antigravity(`agy`)는 허브가 CLI를 직접 실행하므로 별도 프로젝트 설정 파일이 필요 없습니다.
- **허브 API로 첫 방을 구성할 때:** 설치 폴더의 `local/hub.json`에서 `url`, `token`, `browserUrl`을 읽어 로컬 요청에만 사용한다. `GET /state`는 `Authorization: Bearer <token>`으로 조회한다. `POST /control`은 `browserUrl`을 먼저 열어 받은 `agent_room` 세션 쿠키와 `Origin: <url>`, `Content-Type: application/json`을 사용한다. 자동화 클라이언트는 같은 쿠키 세션을 유지한다. 키·토큰·쿠키를 출력하지 않는다.
  - 방 생성은 `{"action":"create","name":"테스트 방"}`을 보내고 응답의 `createdRoom`을 사용한다.
  - 에이전트 생성은 `{"action":"new_agent","room":"<createdRoom>","provider":"codex"}`를 보낸다. 확인한 CLI에 따라 `codex`, `claude`, `agy` 중 하나를 사용한다.
  - 에이전트가 준비되면 `{"action":"user_message","room":"<createdRoom>","text":"파일은 수정하지 말고 한 줄로 인사해 주세요."}`를 보내고 인증된 `/state`에서 해당 방의 새 답변을 확인한다.

같은 프로젝트에서 다시 실행해도 MCP 등록은 중복되지 않습니다. 이전 설치 경로를 가리키는 Agent Room 항목은 설정 파일을 백업한 뒤 새 경로로 갱신합니다. 그 밖의 기존 항목과 충돌하면 확인을 요청합니다.

`-Test`의 CLI 검사는 실행 파일이 응답하는지와 격리 연결 테스트를 확인합니다. 실제 로그인 및 모델 응답은 첫 메시지로 확인합니다. 해결되지 않은 오류는 버전과 실패 단계, 시도한 조치를 민감한 정보 없이 보고합니다. 공개 [이슈](https://github.com/lemoncube7/agent-room-local/issues) 등록은 사용자가 승인한 경우에 진행합니다.

---

## 업데이트 · 검증 · 보안

- **자동 업데이트:** **⚙ 설정 → 업데이트 확인 → 업데이트 설치**에서 진행합니다. 업데이트는 GitHub 릴리스의 `SHA256SUMS.txt`로 ZIP 무결성을 검증한 뒤 `local/`을 보존하며 적용하고, 새 허브 기동 실패 시 이전 파일로 자동 복구합니다.
- **통합 테스트:** Windows ZIP에서는 `node smoke-test.cjs`를, 소스 체크아웃에서는 `node remote-site/smoke-test.mjs`도 실행할 수 있습니다. `start.ps1 -Check`는 실행 창 로드 검사입니다.
- **데이터·보안·백업·제거·문제 신고:** [SECURITY.md](SECURITY.md) 참고
- **라이선스:** [MIT License](LICENSE)
- **원격 연결 및 개발 인계:** [REMOTE-SETUP.md](REMOTE-SETUP.md), [HANDOFF.md](HANDOFF.md)
