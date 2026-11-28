# 변경 후 검증 체크리스트

수정한 영역에 따라 아래 명령으로 검증합니다:
- JS 문법 검사: `node --check hub.cjs` (수정한 `.cjs` / `.mjs` 대상)
- 인라인 스크립트 검사: `index.html`(스크립트 2개), `remote-site/page.html`의 **모든** `<script>`를 `matchAll`로 추출해 각각 `new Function(code)`
- 허브 통합 테스트: `node smoke-test.cjs` (1~2분 걸린다. 짧은 제한 시간으로 돌리면 실패처럼 보일 수 있다)
- 원격 릴레이/다중 노드 테스트: `node remote-site/smoke-test.mjs`
- Cloudflare 자동 설정 테스트: `node cloudflare-setup-test.cjs`

## 릴리스 · 배포 주의
- 릴리스 명령은 `E:\agentroomfolder\release.ps1 -Version X -Commit HEAD`. VERSION·CHANGELOG 갱신과 커밋을 먼저 해 둔다.
- **새 파일을 추가하면 `release.ps1`의 `$files` 목록에도 넣는다.** 빠지면 릴리스 ZIP에서 누락된다. (`update.ps1`은 ZIP 안의 파일을 모두 설치하므로 목록은 `release.ps1` 쪽이 기준이다.)
- 원격 페이지·Worker를 바꿨다면 새 버전 설치 뒤 Cloudflare 자동 설정을 다시 실행해 Worker를 재배포해야 폰에 반영된다. 수동 `wrangler deploy`를 쓴다면 `wrangler.toml` 기본 이름(`agent-room-remote`)이 아니라 `local/remote-config.json`의 `site` 호스트명(`agent-room-<12hex>`)으로 `--name`을 지정한다.

> 상위 목차: [ARCHITECTURE.md](../../ARCHITECTURE.md)
