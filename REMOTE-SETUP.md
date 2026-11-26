# Agent Room 원격 연결 안내

## 원격 연결 작업을 맡은 GPT/Codex

사용자가 Agent Room 원격 연결을 요청하면 아래 절차를 실행한다.

1. 현재 설치 버전, 실행 중인 허브, 원격 중계 설정과 연결된 Site를 확인한다. 기존 비공개 Site가 있으면 재사용한다. PC와 Sites에 각각 접근할 수 있는지 확인하고 접근 가능한 쪽부터 진행한다.
2. 설치 버전과 호환되는 `remote-site/` 소스와 D1 마이그레이션으로 소유자 비공개 Site를 준비한다. 기존 로컬 기록과 진행 중인 CLI 세션을 보존한다.
3. PC 앱의 **원격 연결**에서 Site와 중계를 연결하고, 에이전트가 연결된 새 테스트 방 하나만 공유한다. 기존 방 전체 공유는 사용자가 요청한 경우에 설정한다. 키와 토큰은 채팅·로그·저장소에 출력하지 않는다.
4. **Site → PC → 에이전트 → Site**를 실제로 검증한다. 완료 보고에는 접속 링크와 확인한 단계를 적는다. 사용자 계정 로그인, Sites 접근 또는 Windows PC 접근이 필요한 경우에는 이미 끝낸 단계와 사용자가 해야 할 동작을 구체적으로 알린다.

## 연결 흐름

원격 사용자는 소유자 비공개 Site에서 메시지를 입력한다. Site는 해당 메시지를 대기열에 넣는다. Windows PC의 원격 연결 프로그램은 HTTPS로 그 대기열을 읽고 Agent Room의 한 방에 넣는다. Agent Room의 공개 메시지는 같은 연결을 통해 Site로 돌아온다. PC의 4317 포트는 로컬 전용이다.

- PC의 원격 방 설정에서 공유할 방을 선택한다. 새로 선택한 방의 기존 기록과 지정 수신자가 있는 메시지는 보내지 않는다.
- 사이트에는 채팅 본문과 표시 이름, 작성 시각만 전달한다. 프로젝트 파일·작업 폴더 경로·토큰은 업로드하지 않는다. 답변 본문 자체에 민감한 자료가 들어 있으면 해당 방을 원격으로 연결하지 않는다.
- PC가 꺼졌거나 허브가 내려가면 Site의 새 메시지는 대기한다. 원격 연결을 켜 두면 허브가 다시 시작될 때 중계도 함께 시작한다.
- 원격 Site 하나에는 PC 한 대만 연결한다. 같은 PC의 여러 방을 분리해 표시한다.

## 1. Site 준비

1. ChatGPT Sites에서 서버 동작을 지원하는 Vinext 시작 프로젝트를 **소유자 비공개**로 만든다. 공개 URL로 전환하지 않는다.
2. `remote-site/page.jsx`를 `app/page.jsx`에 복사한다. `remote-site/route.js`와 `handler.mjs`를 둘 다 `app/api/room/[...route]/`에 복사한다.
3. Sites의 D1 바인딩 이름을 `DB`로 선언한다. `remote-site/schema.sql`, `remote-site/0001_multiple_rooms.sql`, `remote-site/0002_remote_state.sql`, `remote-site/0003_remote_command_id.sql`의 테이블과 인덱스를 시작 프로젝트의 D1 마이그레이션에 반영한다. 시작 프로젝트에서 제공하는 Drizzle 마이그레이션 생성·검증 절차를 사용한다.
4. Site의 비밀 설정에 무작위 32바이트 이상의 `REMOTE_DEVICE_KEY`를 등록한다. ChatGPT 로그인 상태로 비공개 Site의 `/api/room/whoami`에서 확인한 소유자 ID를 `REMOTE_OWNER_ID`에 등록한다. 비밀은 브라우저 코드나 Git에 넣지 않는다.
5. 해당 비공개 Site가 Windows에서 호출을 받을 수 있도록 Sites의 서비스 액세스를 준비한다. `siwc_bypass_bearer_token`이 제공되면 대상 Site 호출에만 사용한다. 이 토큰은 브라우저 방문자 신원이 아니다. 제공 여부나 유효 기간을 추측하지 말고 실제 설정과 기기 호출로 확인한다.

## 2. 홈 PC에 연결

Agent Room을 열고 왼쪽 아래 **원격 연결**에서 Site 주소, 장치 키, 필요한 경우 서비스 액세스 토큰을 입력한다. 원격 중계를 켜고 저장한 뒤 **실행 중**인지 확인한다. 새 테스트 방을 만들고 방 메뉴에서 **원격 공유 켜기**를 선택한다.

### 수동 중계 진단

앱에서 관리하는 중계를 끈 상태에서만 Agent Room 설치 폴더에서 아래 명령으로 별도 중계를 시험한다. 실제 키나 토큰은 로컬 PowerShell의 보안 입력 프롬프트로 입력한다.

```powershell
$site = Read-Host '비공개 Site 주소'
$room = Read-Host '테스트 방 이름 또는 ID'
$key = Read-Host 'Site에 등록한 REMOTE_DEVICE_KEY' -AsSecureString
$access = Read-Host 'Sites 서비스 액세스 토큰 (제공되지 않으면 Enter)' -AsSecureString
try {
  $env:AGENT_ROOM_DEVICE_KEY = [pscredential]::new('agent-room', $key).GetNetworkCredential().Password
  $env:AGENT_ROOM_SITE_ACCESS = [pscredential]::new('agent-room', $access).GetNetworkCredential().Password
  node .\remote-sync.cjs $site $room
} finally {
  Remove-Item Env:AGENT_ROOM_DEVICE_KEY,Env:AGENT_ROOM_SITE_ACCESS -ErrorAction SilentlyContinue
}
```

## 3. 실제 왕복 확인

- 소유자 계정이 아닌 요청의 조회·전송이 거절되는지 확인한다.
- 원격 Site에서 테스트 문장을 보내고 로컬 방에 한 번만 들어오는지 확인한다.
- 에이전트의 답변이 원격 Site에 표시되는지 확인한다.
- 테스트 허브를 잠깐 다시 시작한 뒤 원격 대기열의 문장이 중복 없이 들어오는지 확인한다.
- 첫 연결 전에 있던 기록, 지정 수신자 메시지, 다른 방의 메시지가 Site 목록에 없는지 확인한다.

`node remote-site/smoke-test.mjs`는 D1과 호환되는 테스트 어댑터로 요청 권한, 양방향 대기열, 중복 방지를 검사한다. 실제 Sites 배포와 서비스 액세스는 따로 검증해야 한다.
