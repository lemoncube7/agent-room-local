# 설정 도우미 방 (`index.html`, `hub.cjs`)

- 우측 하단 `💬` 버튼 또는 `Alt+클릭`(터치 길게 누르기)은 `assistant_room` 액션을 호출해 대화 모드(`work_mode='chat'`)의 **"설정 도우미"** 방을 엽니다.
- 방 공통 지침(`memo`)은 💬를 누를 때마다 `ensureAssistantRoom()`이 새로 만든다(앱 사용법 + 허용 동작 목록 + 상태 요약 1300자, 전체 3990자 이내). 방 설정 창에서 지침을 저장하면 맨 앞 표시가 지워져 카드가 안 뜰 수 있으니, 그땐 💬를 다시 누르면 복구된다. 상태 요약은 방을 열 때 찍은 것이라 오래 대화했다면 💬로 갱신한다.
- 방 공통 지침(`memo`) 맨 앞의 `ASSISTANT_ROOM_MARK` (`'[설정 도우미 방]'`)로 식별합니다. (`index.html`에서 `ASSISTANT_ROOM_MARK`와 `isAssistantRoom`은 초기화 순서 오류(TDZ) 방지를 위해 `<script>` 상단에 선언합니다.)
- 도우미 에이전트 응답의 ```` ```agent-room-action {...}``` ```` 블록은 `splitAssistantActions()`가 허용 목록(`create`, `rename_room`, `set_work_mode`, `new_agent`, `apply_update`, `cloudflare_setup_start`, `report_issue` 등)만 파싱해 `[실행]`/`[취소]` 카드로 렌더링합니다.
- **허용 목록은 두 곳에 있다:** `hub.cjs`의 `ASSISTANT_ACTIONS`(+`report_issue`)와 `index.html`의 `splitAssistantActions`. 동작을 추가할 때 둘을 함께 고쳐야 한다. 전체: `create`, `rename_room`, `set_work_mode`, `room_memo`, `room_ranking`, `new_agent`, `edit_agent`, `pause_agent`, `disconnect`, `login_cli`, `retry_agent`, `refresh_limits`, `remote_share`, `check_update`, `apply_update`, `cloudflare_setup_start`, `report_issue`.
- `report_issue` 카드는 `assistant_issue_url`로 개인정보를 가린 GitHub 새 이슈 주소를 받아 새 탭을 연다. 예전 팝업용 `assistant_ask`·`assistant_config`·`assistant_reset`은 서버에 남아 있지만 화면은 쓰지 않는다. 카드 실행 결과는 `localStorage`(`agentRoomAssistantDone`)에 저장돼 새로고침해도 버튼이 되살아나지 않는다.

## 설계 의도

- **팝업이 아니라 방 (오퍼스·소네트):** 작은 창은 세션·모델·실행 결과를 따로 관리해야 해서 계속 어색했다(모델을 잘못 말하고, 초기화 버튼도 없었음). 일반 방 기능을 그대로 쓰게 했다.
- **설정 변경은 확인 카드로만 (오퍼스):** 채팅 글은 권한이 아니라는 원칙. 도우미는 제안만 하고, 사용자가 [실행]을 눌러야 적용된다. 허용 목록 밖의 동작은 실행하지 않는다.
- **진단 먼저 (오퍼스):** "덜 끝났다면 눌러보세요" 같은 조건부 답이 사용자에게 "대충 던진다"는 지적을 받았다. 실제 상태를 근거로 무엇이 왜 막혔는지 말하게 했다.

> 상위 목차: [ARCHITECTURE.md](../../ARCHITECTURE.md)
