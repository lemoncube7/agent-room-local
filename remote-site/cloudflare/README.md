# Cloudflare Workers + D1 원격 서버 배포 안내

**본인 Cloudflare 무료 계정(Workers + D1)**에 Agent Room 원격 서버를 배포하는 구성입니다.  
Windows ZIP을 푼 환경에서는 **`설치폴더\app\remote-site\cloudflare`** 안에 이 파일들이 들어 있습니다.

## 1. 원클릭 초기 설정 및 배포 (처음 1회)
PowerShell에서 해당 폴더로 이동해 `deploy.ps1`만 실행하면 됩니다:

```powershell
cd "설치폴더\app\remote-site\cloudflare"
.\deploy.ps1
```

`wrangler.toml`이 없으면 스크립트가 자동으로 다음을 순서대로 처리합니다:
1. Cloudflare 로그인 확인 (`npx wrangler login`)
2. D1 데이터베이스(`agent-room-db`) 생성 및 `wrangler.toml` 자동 생성
3. 무작위 64자리 `REMOTE_DEVICE_KEY` 생성·등록 및 화면 출력
4. 원격 접속 비밀번호(`REMOTE_ACCESS_PASSWORD`) 입력받아 시크릿 등록
5. D1 스키마·마이그레이션 적용 및 Worker 배포

## 2. PC 앱에 연결
1. 배포 완료 시 출력된 Worker URL(`https://agent-room-remote.<subdomain>.workers.dev`)과 `REMOTE_DEVICE_KEY`, `REMOTE_ACCESS_PASSWORD`를 준비합니다.
2. PC Agent Room 왼쪽 아래 **⚙ 설정 → 원격 연결**에서 **원격 호스팅** 또는 **둘 다**를 선택하고 값을 저장합니다.
3. 브라우저로 Worker URL에 접속해 비밀번호로 로그인하면 소유자만 채팅을 보고 보낼 수 있습니다.

## 3. 이후 업데이트 배포
이미 `wrangler.toml`이 있는 상태에서는 같은 명령만 다시 실행하면 마이그레이션과 코드 업데이트만 깔끔하게 적용됩니다:

```powershell
.\deploy.ps1
```
