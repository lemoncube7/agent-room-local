# Agent Room 작업 지침

- 세션 맥락이 부족하거나 새로 합류했다면 먼저 [ARCHITECTURE.md](ARCHITECTURE.md)를 읽어 전체 구조·DB·제어 태그·원격/업데이트 원리를 파악하세요.
- 기능, API, DB 스키마, 제어 태그, UI 동작, 원격/푸시/업데이트 로직을 수정하거나 추가할 때는 **같은 작업 안에서 [ARCHITECTURE.md](ARCHITECTURE.md)도 함께 최신화**하세요.
- 수정 후에는 관련 문법 검사와 스모크 테스트(`smoke-test.cjs`, `remote-site/smoke-test.mjs` 등)를 실행해 결과를 확인하세요.
