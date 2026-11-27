# Agent Room 원격 연결 안내 (직접 서버 · Cloudflare Workers + D1)

Agent Room은 **직접 서버 (PC 허브 · PWA)**와 **Cloudflare Workers + D1 원격 호스팅** 두 가지 원격 방식을 지원하며, **둘 다** 켜 두면 PC가 켜져 있을 때는 직접 서버(실시간 SSE), PC가 꺼지면 Cloudflare Workers로 자동 전환됩니다.

## 1. 직접 서버 (PC 허브 · PWA)
- PC 앱 왼쪽 아래 **⚙ 설정 → 원격 연결**에서 **직접 서버** 또는 **둘 다**를 선택하고 저장합니다.
- 허브가 `0.0.0.0:4317`로 열리며, 화면에 표시되는 접속 URL과 접속 키로 폰·외부 기기에서 바로 접속해 **홈 화면에 추가 / 앱 설치(PWA)**로 쓸 수 있습니다.
- **외부에서 폰 앱 없이 HTTPS로 바로 접속하려면 (한도 없음):**
  - **Tailscale Funnel:** PC에 Tailscale을 켜고 `tailscale funnel 4317` 실행 → 폰에 Tailscale 앱을 깔지 않아도 공인 HTTPS 주소(`https://내PC.tailXXXX.ts.net`)로 바로 접속 가능.
  - **Cloudflare Tunnel:** `cloudflared tunnel --url http://127.0.0.1:4317` 실행 → 즉시 HTTPS 주소 생성(요청 수 한도 없음).

## 2. Cloudflare Workers + D1 원격 호스팅 (PC 꺼짐 대비)
PC가 꺼져 있을 때도 폰에서 이전 대화를 보고 메시지를 예약 전송하려면 개인 Cloudflare 무료 계정으로 Worker + D1을 배포합니다.

1. Windows ZIP을 푼 폴더에서 PowerShell을 열고 아래 명령을 실행합니다:
   ```powershell
   cd "설치폴더\app\remote-site\cloudflare"
   .\deploy.ps1
   ```
   - 처음 실행 시 Cloudflare 로그인, D1 데이터베이스(`agent-room-db`) 생성, `wrangler.toml` 생성, `REMOTE_DEVICE_KEY`·`REMOTE_ACCESS_PASSWORD` 시크릿 등록, D1 마이그레이션, Worker 배포까지 자동으로 진행됩니다. (자세한 내용은 `app\remote-site\cloudflare\README.md` 참고)
2. PC 앱 **⚙ 설정 → 원격 연결**에서 **원격 호스팅** 또는 **둘 다**를 선택하고 아래 값을 입력합니다.
   - **Cloudflare Worker 주소:** `https://agent-room-remote.<subdomain>.workers.dev`
   - **REMOTE_DEVICE_KEY:** `deploy.ps1` 실행 시 출력된 64자리 장치 키
   - **Cloudflare 접속 비밀번호:** `REMOTE_ACCESS_PASSWORD` (직접 서버 PWA에서 PC가 꺼졌을 때 자동 전환용)
3. 저장 후 상태가 **실행 중**인지 확인하고, 공유할 방의 방 설정에서 **원격 공유 켜기**를 선택합니다. (또는 **모든 방 항상 공유** 체크)

## 3. 수동 중계 진단
앱에서 관리하는 중계를 끈 상태에서 설치 폴더의 `app` 디렉터리에서 PowerShell로 직접 시험할 수 있습니다.

```powershell
$site = Read-Host 'Cloudflare Worker 주소'
$room = Read-Host '테스트 방 이름 또는 ID'
$key = Read-Host 'Worker에 등록한 REMOTE_DEVICE_KEY' -AsSecureString
try {
  $env:AGENT_ROOM_DEVICE_KEY = [pscredential]::new('agent-room', $key).GetNetworkCredential().Password
  node .\remote-sync.cjs $site $room
} finally {
  Remove-Item Env:AGENT_ROOM_DEVICE_KEY -ErrorAction SilentlyContinue
}
```

## 4. 검증
- `node remote-site/smoke-test.mjs`로 권한 검사, 양방향 대기열, 방 분리, 중복 방지를 로컬에서 검증할 수 있습니다.
