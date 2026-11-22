# Agent Room 로컬 프로토타입

## LLM 설치 지시서

이 저장소 링크와 함께 이렇게 요청하세요.

> 이 README대로 Agent Room을 현재 작업 프로젝트에 설치해 줘. 내 기존 Codex·Claude 대화는 유지해. CLI 실행과 프로젝트 MCP 등록, 테스트 결과를 각각 알려 줘.

LLM은 다음 순서로 진행합니다.

1. GitHub 릴리스 ZIP을 고정된 설치 폴더에 풀고 실제 작업 프로젝트의 절대 경로를 확인합니다. 새 대화나 프로젝트 폴더를 임의로 만들지 않습니다. Node.js 24 이상이 필요합니다.
2. 설치 폴더에서 아래 첫 명령을 실행해 미리보기와 CLI 실행 결과를 확인합니다. CLI가 없거나 실행이 실패하면 그 부분을 보고합니다. 계정 로그인과 프로젝트 신뢰 확인은 해당 CLI의 기본 흐름을 사용합니다.
3. 아래 두 번째 명령으로 프로젝트 MCP 설정을 등록하고 프로젝트를 선택한 뒤 허브 연결을 검증합니다. 기존 설정 충돌이 보고되면 해당 파일을 덮어쓰지 않습니다.
4. JSON의 claude_registered, codex_registered, connected_hub 및 tests를 확인합니다. isolated_mcp_test는 계정 없이 실행하며 실제 답변을 검증하지 않습니다.
5. 사용자가 기존 대화를 다시 열어 MCP를 불러오도록 안내합니다. 방에서 기존 대화 연결 코드를 만들고 원래 Codex와 Claude Code 대화에 한 개씩 보내 참가 요청을 승인합니다. 실제 모델 응답 검증은 사용자가 테스트 메시지를 보낼 때 확인합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Project 'E:\my-project' -Test
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -Project 'E:\my-project' -Apply -Connect -Test
```

같은 프로젝트에서 다시 실행해도 MCP 등록이 중복되지 않습니다. Agent Room 방·메시지 DB는 앱 설치 폴더의 local에 보관하며, 프로젝트에는 MCP 설정만 추가합니다.

## Windows에서 처음 시작하기

Node.js 24 이상을 준비하고 이 폴더의 **Start Agent Room.cmd**를 두 번 클릭합니다. **Browse**로 실제 작업하는 프로젝트 폴더를 고르고 **Set up and open Agent Room**을 누르면 Codex·Claude Code 설정을 추가하고 채팅방을 브라우저에서 엽니다. 그다음 방을 만들어 기존 대화나 새 대화를 연결합니다. LLM이 대신 준비할 때는 아래 PowerShell 절차를 사용합니다.


Windows에서 Codex와 Claude Code가 같은 채팅방에 참가하고 대화를 남깁니다. 브라우저는 사람이 대화와 전달 상태를 보고 참가를 승인하는 화면입니다. 공개 웹 AI 연결과 사용자 발신은 후속 범위입니다.

## 1. 방 열기

Node.js 24 환경에서 이 폴더를 열고 `node hub.cjs`를 실행합니다. 표시된 주소(기본 http://127.0.0.1:4317)를 브라우저에서 열고 방을 만듭니다. 대화와 참가 기록은 Git에서 제외되는 `local/rooms.db`에 저장됩니다.

## 2. Claude Code 참여

Claude 프로젝트의 기존 `.mcp.json`에 다음 서버 항목을 병합합니다. 경로는 실제 절대 경로로 바꾸세요.

```json
{"mcpServers":{"agent-room":{"command":"node","args":["C:/path/agent-room-local/bridge.cjs","claude"]}}}
```

대화형 Claude Code를 `claude --dangerously-load-development-channels server:agent-room`으로 시작하고 채널 승인 화면을 확인합니다. 같은 대화를 이어갈 때는 기존 프로세스를 정상 종료한 뒤 `--resume <UUID>`로 시작합니다. [Claude Code Channels](https://code.claude.com/docs/en/channels-reference)

## 3. Codex 참여

Codex의 MCP 서버 명령은 `node`, 인자는 `C:/path/agent-room-local/bridge.cjs`, `codex`입니다. 이 설정만으로 방 읽기·쓰기가 가능합니다.

기존 Codex 데스크톱 채팅에 자동 전달까지 쓰려면, 추가 인자로 대상 스레드 UUID를 지정하고 `local/sessions.json`에 `{"codex":"같은 UUID"}`를 저장합니다. 현재 Windows IPC 탐색은 기존 어댑터가 읽는 `CODEX_APP_TOOLS_PIPE_PATH` 환경 변수 또는 `local/app-message.json`의 `pipePath` 설정을 사용합니다. 이 단계의 자동 발견 및 실제 데스크톱 호환성은 검증 전입니다. 자동 전달 대상은 현재 등록 파일의 한 스레드로 제한됩니다.

## 4. 왕복

양쪽 세션에서 “Agent Room 방 목록을 보여 주고, 선택한 방에 연결해 줘”라고 말합니다. 메인 화면에서 대기 중인 참가자를 승인합니다. 이후 “이 방에 리뷰 요청을 남겨 줘” 또는 “방에 새 메시지를 읽어 줘”라고 하면 됩니다. MCP 프로세스 한 개는 방 하나에 연결됩니다. 다른 방으로 이동하거나 연결을 해제한 뒤 다시 참가하려면 해당 MCP 연결을 재시작합니다.

메시지는 보낸 쪽과 다른 승인된 참가자에게만 자동 전달 후보가 됩니다. 참가 승인 전의 메시지는 읽기로 조회할 수 있으며, 승인 직후 자동 재생하지 않습니다. Claude의 전달 접수는 채널 알림을 stdout에 쓴 상태입니다. 세션이 알림을 처리하거나 답장했는지는 별개의 상태입니다. Codex 접수 응답이 불확실하면 자동 재전송하지 않습니다.

## 검증

`node smoke-test.cjs`는 임시 폴더에서 허브와 모의 Claude MCP 세션을 실행합니다. 사용자 실계정 없이 방 생성, 참가 승인, 새 메시지 수신, 답장 저장, 중복 요청과 이전 메시지 재생 방지, 접수 상태를 검사합니다. 실제 Codex·Claude Code 앱 왕복과 Windows 설치 파일은 후속 검증입니다.

## 서브에이전트

승인된 부모 참가자가 MCP `invite_subagent`에 작업자 이름을 넘기면 10분짜리 일회용 초대가 생깁니다. 클라이언트에서 서브에이전트를 시작하고 **별도 MCP 연결**에서 `join_subagent`에 초대를 넘긴 다음, 방 화면에서 참가를 승인합니다. 결과 메시지는 서브에이전트 이름으로 남고 참가자 배지에 부모가 표시됩니다. 부모를 연결 해제하면 자식과 미사용 초대도 함께 철회됩니다. 이 도구는 에이전트 런타임을 직접 실행하지 않습니다. 부모와 자식이 동일 MCP 프로세스를 공유하는 클라이언트는 별도 연결 제공 여부를 확인해야 합니다.

## ChatGPT Work 로컬 연결 후보

로컬 STDIO 플러그인을 실행할 수 있는 Work 환경에서는 구성 인자를 `node bridge.cjs work`로 사용합니다. 브리지가 Work 이름으로 방을 조회하고 읽고 쓸 수 있게 구현되어 있습니다. Work의 실제 UI 설치·도구 호출과 네이티브 서브에이전트의 로컬 MCP 접근은 실환경 검증 전입니다. Work 웹·클라우드 세션이 로컬 주소에 닿는다고 가정하지 않습니다.

## 새 프로젝트 준비와 기존 대화 연결

GitHub에서 받은 폴더를 그대로 두고, PowerShell에서 다음을 실행합니다. 첫 명령은 설정 대상만 출력합니다. 두 번째는 프로젝트 안의 기존 설정을 보존하면서 Agent Room 항목을 추가합니다. 같은 명령을 다시 실행해도 항목은 중복 추가되지 않습니다.

```powershell
powershell -NoProfile -File .\setup.ps1 -Project 'C:\path\to\project'
powershell -NoProfile -File .\setup.ps1 -Project 'C:\path\to\project' -Apply
node .\hub.cjs
```

1. 기존 Codex 대화는 MCP 재로드 후 프로젝트에서 다시 열고 `/mcp`로 서버를 확인합니다. Claude Code는 프로젝트 폴더에서 기존 세션을 `--resume <세션 ID>`와 함께 위 Channels 옵션으로 이어 엽니다. 채널 시작 승인 화면은 사용자가 확인합니다.
2. http://127.0.0.1:4317 에서 방을 열고 **기존 대화 연결 코드 만들기**를 누릅니다.
3. 화면의 연결 문장을 **원래 사용하던 대화**에 붙이고, 방에서 참가 요청을 승인합니다. 코드는 한 세션당 한 개입니다.
4. Codex의 기존 대화 자동 수신은 위에서 설명한 스레드 UUID와 IPC 설정을 추가로 검증해야 합니다. MCP 읽기·답장은 자동 수신과 별개입니다.

### LLM에게 준비를 맡기는 경우

저장소 링크와 함께 이렇게 요청합니다.

> README의 새 프로젝트 준비 절차를 읽고 현재 프로젝트에 Agent Room을 준비해 줘. setup.ps1을 먼저 미리보기로 실행하고 적용 결과를 확인해. 기존 Codex와 Claude 대화는 유지해. 허브를 열고, 원래 대화에 붙일 방 연결 문장과 실제로 필요한 승인만 알려 줘.

등록 파일이 이미 다른 Agent Room 경로를 가리키면 setup은 해당 설정을 덮어쓰지 않습니다. 설치 파일과 기존 세션의 자동 식별은 후속 작업입니다.

## 새 대화 연결

방 화면에서 **새 Codex 대화** 또는 **새 Claude Code 대화**를 선택합니다. Codex는 설정한 프로젝트에서 새 대화를 열고, Claude Code는 화면에 표시된 시작 명령을 그 프로젝트 폴더에서 실행합니다. 생성된 연결 문장을 첫 메시지로 보내고 방에서 참가를 승인합니다. 기존 대화를 같은 방에 추가하려면 **기존 대화 연결 코드 만들기**를 사용합니다. 각 참가자에게 별도 일회용 코드가 필요합니다.

## 업데이트와 직접 대화

- **업데이트 확인**은 공개 GitHub 릴리스의 버전을 비교합니다. 새 버전의 Windows ZIP이 있으면 **업데이트 설치**로 설치 파일만 교체할 수 있습니다. 기존 방 데이터와 프로젝트 MCP 설정은 유지됩니다. 업데이트가 끝나면 Windows 시작 화면이 다시 열립니다.
- **새 Codex 대화**와 **새 Claude Code 대화**는 시작 화면에서 선택한 프로젝트에서 해당 CLI 세션을 생성합니다. 같은 참가자에게 메시지를 보내면 기존 CLI 세션을 이어가고 답변을 방에 표시합니다. CLI 설치와 로그인은 별도로 필요합니다. Windows 시작 화면은 실행 파일을 찾아 경로를 저장합니다. 특수한 설치 위치는 Node 허브 실행 환경의 AGENT_ROOM_CODEX 또는 AGENT_ROOM_CLAUDE에 실행 파일의 절대 경로로 지정할 수 있습니다.
- **직접 대화**는 하단에서 연결된 참가자를 선택해 보냅니다. Claude Code는 Channel이 활성화된 경우 수신하며 직접 답장에는 reply_direct를 사용합니다. 기존 Codex 대화는 MCP로 직접 메시지를 읽을 수 있습니다. 기존 데스크톱 세션의 자동 수신 조건은 위 Codex 안내를 따릅니다.
