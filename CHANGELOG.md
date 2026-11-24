# Changelog

## v0.2.46
- **기존 대화 이어서 연결 (`+ 추가` 직접 세션 재개):** MCP 채널/파이프 제약 없이 허브가 최근 로컬 세션(Claude `~/.claude/projects`, Codex `~/.codex/sessions`, Antigravity `~/.gemini/antigravity-cli/brain`)을 자동 탐색해 `기존 대화 이어서 연결` 드롭다운에서 클릭 한 번으로 바로 연결·재개할 수 있습니다.
- **설치·업데이트 시 전역 MCP 자동 적용 (`start.ps1`, `update.ps1`):** `Start Agent Room` 실행 및 자동 업데이트 시 `setup.ps1 -Apply -SelectProject -Global`을 자동 실행해 별도 수동 설정 없이도 Codex · Claude · Antigravity 전역 MCP가 유지됩니다.

## v0.2.45
- **전역 MCP 자동 등록 (`setup.ps1 -Global`):** 프로젝트 변경 시 Codex(`~/.codex/config.toml`), Claude(`~/.claude.json`), Antigravity(`agy mcp add`) 전역 MCP 설정을 함께 등록·갱신할 수 있습니다.
- **기존 대화 MCP 연결 개선 (`bridge.cjs`):** `CODEX_THREAD_ID`가 있는 Codex 세션은 승인 즉시 데스크톱 푸시(`bind_codex_desktop`)를 자동 연결하고, Claude/Codex 수동 조건 안내를 보강했습니다.
- **다중 1순위 사전 조율 (`hub.cjs`):** 여러 에이전트에게 동시에 `priority: 1`이 배정될 때, 겹치는 작업이면 먼저 조율/분담을 제안하고 충돌을 피하도록 턴 지침을 보강했습니다.
- **권한 승인 팝업 대폭 축소 (`hub.cjs`, `bridge.cjs`):** `dev` 권한에서 따옴표 안 정규식 `|` 및 안전한 체인 명령(`;`, `&&`, `||`, `|`, `if ($?)`), `Select-String`/`Get-ChildItem`/`node`/`npm`/`npx`/`python`/`cargo`/`go`/`dotnet`/`gh` 읽기·검증 명령을 자동 허용합니다.

## v0.2.44
- **권한 승인 로그:** 모든 권한 허용 요청과 처리 결과(`pending`/`allowed`/`allowed_always`/`auto_allowed`/`denied`/`expired`)를 SQLite(`approval_logs`)와 `local/approvals.log`에 자동 기록하고, 방 메뉴 `⋯` → `권한 승인 로그`에서 조회할 수 있습니다.
- **대화 흐름 & 작업 패널 & 작업 시작 안내:** 원래 요청 아래에 순위·호출 흐름을 표시하고, 긴 중간 출력은 오른쪽 접을 수 있는 작업 패널로 분리했습니다. 에이전트가 작업 시작 시 남긴 한 줄 안내를 오른쪽 카드에 실시간 표시합니다.
- **방 관리 기능 확장:** `방 빠른 준비`(기존 방의 에이전트·설정 복제), `이 방 삭제`(진행 중 보호 포함), 방 이름 수정 및 통합 `방 설정` 창을 추가했습니다.
- **방 목록 알림 배지 & `agy` 사용량 갱신:** 왼쪽 방 목록에 읽지 않은 `새 메시지`와 미확인 `승인 N` 배지를 표시하고, `agy` 사용량 파일(`agyUsageFile` / `AGENT_ROOM_AGY_USAGE_FILE`) 최신화를 개선했습니다.

## v0.2.41
- **Antigravity(`agy`) 권한 승인 카드 연동:** `agy acp --stdio` 어댑터를 추가해 `edit`·`dev` 권한에서 위험 명령 실행 시 PC 앱과 원격 UI에 승인 카드를 띄웁니다.
- **전달·우선순위 연쇄 및 안전장치:** 수신 시 동료 전달 상태를 공유하고, `n-1` 순위 에이전트가 `[[CALL:id]]`/`[[NEXT:id]]`로 다음(`n`순위)을 이어받을 수 있습니다. 질문·요청 메시지에서 전원 `0`순위일 때 자동 승격 및 `1순위로 깨우기` 버튼을 추가했습니다.
- **한도 표시 및 원격 UI 개선:** 초기화 시각이 지난 한도는 `남음 100% (초기화됨)`으로 표시하고, `agy` 카드는 모델에 맞는 2개 막대만 표시합니다. `file://` 링크 클릭 복사, 번호 목록(`start`) 유지, 코드 블록 복사 버튼 고정, 승인 요청 알림, 최근 활동 방 순 정렬을 반영했습니다.
- **배포·문서 정리:** `LICENSE`, `SECURITY.md`, 최신 `README.md`, `update.ps1` 한국어 상태 안내 및 실패 시 자동 롤백을 포함했습니다.
