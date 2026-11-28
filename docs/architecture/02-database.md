# SQLite 데이터베이스 (`db.cjs`, `local/rooms.db`)

- `rooms(id, name, memo, folder, work_mode, project)`: 방 목록. `work_mode`는 `'chat'` 또는 `'dev'`.
- `members(id, room, name, state, parent, paused, role, sub_kind, position)`: 참여자.
  - `state`: `'human' | 'pending' | 'starting' | 'start_failed' | 'approved' | 'disconnected'`
  - `parent`: 서브에이전트의 부모 ID. `sub_kind`: `'resident'`(상주형) 또는 `'task'`(일회성).
- `cli_sessions(member, project, thread, provider, model, effort, permission_profile, last_cli_error, policy_version, ...)`: CLI 세션 정보, 마지막 오류(`usage_limit`, `auth_expired` 등), 적용된 `policy_version`.
- Windows에서 에이전트의 Codex CLI 대화를 열 때 `--no-daemon resume <thread>`를 사용한다. 데스크톱 앱에 포함된 CLI에서도 별도 백그라운드 서버 패키지 없이 기존 대화를 열기 위함이다.
- `messages(seq, room, author, request, body, created, recipient, remote_source, relay_root, retracted)`:
  - `recipient`: 1인 지정(`[[TO:이름]]`) 대상.
  - `remote_source`: `'direct'`(PC 직접 연결) 또는 `'site'`(Site 경유).
  - `relay_root`: 원 요청 `seq`.
- `deliveries(seq, member, state, priority)`: 에이전트별 전달 상태(`queued`, `ranking`, `submitting`, `working`, `accepted`, `answered`, `context_only`, `context_seen`, `failed`, `coordination_wait`, `coordination_speaking`, `coordination_blocked`).
- `room_ranking(room, enabled, mode, main_member, judge_provider, judge_model, judge_effort, judge_prompt)`: 응답 모드(`broadcast` | `ranking` | `hierarchy`) 및 판정 설정.
- `reply_plans`, `coordination_turns`: 조율(`opinions`, `coordinating`, `ready`) 상태 및 라운드 순서. 이의(`[CHANGE]`·`[BLOCKED]`)가 있으면 최대 `COORD_MAX_ROUNDS`(6)라운드까지 다시 돈다(`hub.cjs`에서 기존 DB 기본값 3보다 우선).
  - 조율 발언은 각 에이전트의 **메인 세션을 읽기 전용 턴으로 이어서** 돈다(`runCodex(project, prompt, thread, …, {permission:'chat'})`, 웜 세션은 먼저 정리). Codex는 `exec resume`이 `--sandbox`를 거부하므로 `-c sandbox_mode="read-only"`를 쓴다. 아직 세션이 없는 에이전트만 일회성 호출(`rank:true`)로 대신한다. 프롬프트에 원 요청과 직전 방 메시지 12개(`recentRoomMessages`)를 넣고, 조율 메시지는 `storeCoordinationMessage`로 방의 다른 에이전트에게 `context_only` 전달을 만들어 다음 메인 턴에 보이게 한다. 실행을 맡지 않은 참여자의 원 요청 전달도 `context_only`로 남긴다.
- `remote_rooms(room, since)`, `remote_options`: 원격 공유 방 및 전체 자동 공유(`share_all`).
- `approval_rules`, `approval_logs`: 도구 실행 항상 허용 규칙 및 승인 로그.
- `handoff_tasks`, `handoff_history`: 작업 카드(id·owner·verifier·done_when·files·revision 등)와 그 변경 이력. 원격 Site(D1)에는 푸시용 `remote_push_key`(VAPID 서명 키), `remote_push_subscriptions`(구독)가 별도로 있다.
- `delivery_history`: **모든 메시지**에서 에이전트별 전달 상태가 바뀔 때마다 쌓이는 기록(대기 → 순위 판정 → 작업 중 …). 원격 메시지 전용이 아니다.
- `desktop_bindings`, `handoff_alerts`, `mesh_message_copy`: 데스크톱 바인딩, 작업 인계 알림, 다중 노드 메시지 동기화.
- **시작 시 DB 무결성 검사 (`hub.cjs`):** 허브 시작 직후 `PRAGMA quick_check`를 실행해 이상이 있으면 `startupDbIssue`에 원인을 기록하고 `/state`의 `dbIssue` 및 `diagnose`(`diagnoseNow`) 결과로 노출한다. (깨진 DB를 임의로 복구·삭제해 데이터를 잃는 대신 이유를 먼저 사용자에게 알리기 위함.)
- **DB를 열 수 없을 때:** SQLite가 손상 또는 잘못된 DB 형식을 보고하면 허브는 현재 실행의 오류 안내를 파일에 기록하고 종료한다. Windows 시작 화면은 그 실행에서 기록된 안내를 표시한다. 원본 DB를 보관한다.

> 상위 목차: [ARCHITECTURE.md](../../ARCHITECTURE.md)
