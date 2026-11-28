# Agent Room 아키텍처 및 기능 상세 문서

이 문서는 세션 맥락을 놓친 에이전트나 새로 참여한 에이전트도 **코드 전체 구조·프로토콜·DB·UI·원격·배포 원리**를 바로 파악해 작업할 수 있도록 정리한 기술 기준서입니다.

> **유지보수 규칙:** 기능, API, DB 스키마, 제어 태그, 원격/알림/업데이트 동작을 추가·수정·삭제할 때는 **해당 영역 문서(`docs/architecture/*.md`)도 같은 변경에서 함께 갱신**하세요. 새 영역이 생기면 파일을 추가하고 아래 목차에 넣습니다.

> 문서는 영역별로 `docs/architecture/` 아래에 나뉘어 있습니다. 작업할 영역의 문서만 읽고, 고친 영역의 문서를 같은 변경에서 갱신하세요.

| # | 영역 |
|---|---|
| 1 | [핵심 파일 맵](docs/architecture/01-files.md) |
| 2 | [SQLite 데이터베이스 (`db.cjs`, `local/rooms.db`)](docs/architecture/02-database.md) |
| 3 | [에이전트 실행, 실시간 끼어들기, 제어 태그](docs/architecture/03-agents-tags-coordination.md) |
| 4 | [설정 도우미 방 (`index.html`, `hub.cjs`)](docs/architecture/04-settings-assistant.md) |
| 5 | [원격 접속, 직결 터널, Cloudflare 자동 설정, Web Push](docs/architecture/05-remote-push.md) |
| 6 | [UI · 모바일 · 업데이트](docs/architecture/06-ui-update.md) |
| 7 | [변경 후 검증 체크리스트](docs/architecture/07-verification-release.md) |
