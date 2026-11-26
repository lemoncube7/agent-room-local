# 독립 Cloudflare Workers + D1 배포 안내

ChatGPT Sites 없이 **본인 Cloudflare 무료 계정(Workers + D1)**에 Agent Room 원격 서버를 독립 배포하는 구성입니다.

## 1. 초기 설정 (1회)
1. `wrangler` 로그인:
   ```powershell
   npx wrangler login
   ```
2. D1 데이터베이스 생성:
   ```powershell
   npx wrangler d1 create agent-room-db
   ```
3. `wrangler.toml.example`을 `wrangler.toml`로 복사하고 `database_id`를 채웁니다.
4. 시크릿 2개를 등록합니다(Git이나 코드에 절대 저장하지 않음):
   ```powershell
   npx wrangler secret put REMOTE_DEVICE_KEY       # 32자 이상 무작위 문자열 (PC 앱에 입력할 키)
   npx wrangler secret put REMOTE_ACCESS_PASSWORD  # 16자 이상 소유자 로그인 비밀번호
   ```

## 2. 배포 및 마이그레이션
```powershell
.\deploy.ps1
```
- `../schema.sql` 및 `0001`~`0003` 마이그레이션을 D1에 적용하고 `worker.mjs`를 배포합니다.
- 배포된 Worker URL을 PC Agent Room의 **⚙ 설정 → 원격 연결**에 입력하고 `REMOTE_DEVICE_KEY`를 저장하면 바로 연결됩니다.
- 브라우저로 Worker URL에 접속하면 `REMOTE_ACCESS_PASSWORD` 로그인 화면이 뜨며, 로그인한 소유자만 채팅을 보고 보낼 수 있습니다.
