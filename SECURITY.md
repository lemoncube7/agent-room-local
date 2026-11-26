# 데이터·보안 및 백업 안내

## 1. 로컬 데이터 저장 위치
Agent Room은 별도 클라우드 DB 없이 설치 폴더 아래 `local/` 디렉터리에 데이터를 저장합니다.

- `local/rooms.db`: 채팅방, 참가자, 메시지, 전달 상태, 작업 인계, 방 고정 메모, 역할 설정
- `local/uploads/`: 채팅방에 첨부한 파일
- `local/cli.json`: 감지된 CLI 실행 파일 경로 및 샌드박스 설정
- `local/project.txt` / `local/recent-projects.json`: 선택된 작업 프로젝트 경로
- `local/limits-*.json`: 프로바이더별 구독 잔여량 스냅샷 (계정 토큰·비밀번호는 저장하지 않음)
- `local/update.log`: 자동 업데이트 실행 로그
- `local/approvals.log`: 권한 요청에 대한 처리 로그. 명령 입력에 개인 경로나 작업 내용이 포함될 수 있습니다.

허브 HTTP 서버(`hub.cjs`)는 `127.0.0.1:4317`(로컬 루프백)에만 바인딩됩니다.
- **로컬 인증:** 화면 접근, `/state`, `/control`, `/uploads`는 실행 시 `local/browser-key`로 발급되는 브라우저 접속 키(세션 쿠키)와 `Origin` 검증으로 보호됩니다. `/tool`, `/delivery`, 스크립트용 `/state` 조회는 `local/hub.json`의 Bearer 토큰이 필요합니다.
- **전역 CLI 설정 보존:** 기본 실행 및 업데이트는 선택한 프로젝트 폴더 내부(`.mcp.json`, `.codex/config.toml`)만 설정하며, 사용자 전역 `~/.codex/config.toml`·`~/.claude.json`은 사용자가 명시적으로 `-Global`을 지정하지 않는 한 수정하지 않습니다.
- **업데이트 무결성 검증:** `update.ps1`은 GitHub 릴리스의 `SHA256SUMS.txt`를 내려받아 ZIP 해시가 일치할 때만 설치합니다. `Agent Room.exe`의 전체 C# 소스(`launcher.cs`)와 재현 빌드 스크립트(`build-exe.ps1`)가 저장소와 배포 ZIP에 함께 포함됩니다.

## 2. 원격 연결 시 전송되는 데이터
원격 연결(`remote-sync.cjs`)은 기본 꺼짐 상태이며, 사용자가 직접 원격 설정을 켰을 때만 공유 대상 방을 지정한 비공개 서버(ChatGPT Site 또는 독립 Cloudflare Worker)와 동기화합니다. **새로 만든 방은 기본 비공유**이며, 방 설정에서 `원격 공유 켜기`를 누르거나 원격 설정에서 `모든 방 항상 공유`를 켰을 때만 공유됩니다.

- **전송됨:** 공유된 방 목록, 표시 이름, 메시지 본문, 에이전트 상태·잔여량 요약, 실행 허용 요청 카드. 메시지나 명령 입력에 직접 포함된 경로도 함께 전송될 수 있습니다.
- **전송되지 않음:** 프로젝트 소스 코드 전체, `local/hub.json` 토큰, `local/browser-key`, CLI 인증 정보
- **원격 권한 제한:** 원격에서 보낸 지시는 허용된 제어 5종과 지정 필드만 통과하며, 에이전트 권한이 `전체(full)`로 설정되어 있어도 보안상 **`개발(dev)` 등급으로 낮춰 실행**됩니다.

## 3. 에이전트 권한 등급 및 대화 모드
- **대화 모드 (`chat`):** 방 성격이 `대화 모드`일 때는 Codex `read-only`, Claude Code `plan` + 읽기 전용 도구, Antigravity `plan`으로 CLI 실행 권한을 물리적으로 낮추고 수정·실행 승인 요청을 자동 거부합니다.
- **편집 (`edit`):** 작업 폴더 내 파일 수정·조회만 자동 허용
- **개발 (`dev`, 기본값):** 편집 + 읽기·검색 + 안전한 로컬 테스트/빌드(`node`, `npm`, `pytest`, `git status/diff/add/commit` 등) 자동 허용, 삭제·푸시·외부 전송 등은 승인 카드로 확인
- **전체 (`full`):** 모든 도구 및 명령을 확인 없이 자동 허용 (신뢰할 수 있는 로컬 작업에만 권장)

권한 등급은 Agent Room의 승인 정책입니다. 특히 `dev`에서 허용되는 `node`, `npm` 같은 도구는 스크립트를 실행할 수 있습니다. 프로세스의 파일 및 네트워크 접근 범위는 CLI 및 운영체제의 실제 샌드박스 설정에 따릅니다.

## 4. 백업 및 제거 방법
- **백업:** 브라우저 창을 닫은 뒤 백그라운드 Agent Room 허브도 종료하고, 설치 폴더의 `local/` 전체를 다른 폴더에 복사하세요. 방 기록과 첨부 파일은 이 폴더에 저장됩니다.
- **제거:** 런처에서 Windows 로그인 시 자동 시작을 끕니다. 런처를 열 수 없다면 `Win+R`에서 `shell:startup`을 열고 Agent Room의 `Agent-Room-Hub.vbs`를 제거합니다. 허브를 종료한 뒤 필요한 `local/`을 백업하고 설치 폴더를 삭제합니다.
- **MCP 등록 제거:** 프로젝트의 `.mcp.json`과 `.codex/config.toml`, 사용자 전역의 `~/.codex/config.toml`과 `~/.claude.json`에서 이 설치본을 가리키는 `agent-room` 항목만 제거합니다. Claude Desktop이나 Antigravity에도 등록했다면 각 앱의 MCP 설정에서 같은 항목을 제거합니다.

## 5. 문제 신고
오류나 버그를 제보할 때는 다음 정보를 함께 첨부해 주세요.
- 설치된 버전 (`VERSION` 또는 화면 왼쪽 위 `v0.x.x`)
- 재현 절차 및 사용 중인 CLI (`codex` / `claude` / `agy`)
- 필요 시 `local/update.log` 내용 (개인 경로나 토큰이 포함되지 않았는지 확인 후 첨부)
