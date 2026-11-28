# 에이전트 실행, 실시간 끼어들기, 제어 태그

## 3.1 턴 디스패치 및 끼어들기 (`hub.cjs`)
- `dispatchQueuedTurns()`가 `deliveries.state = 'queued'`를 모아 멤버별 실행.
- **작업 중(`cliBusy.has(participant)`) 끼어들기:**
  - `isAlert`와 `isCoordinated`가 아닌 일반 `priority >= 1` 메시지는 `deliverLive(participant, item)`를 호출합니다.
  - 세션이 `.steer` 또는 `.live` 인박스를 지원하면 진행 중인 턴으로 바로 끼어들어 전달되고, 미지원이면 `queued`로 남아 현재 턴 종료 후 실행됩니다.

## 3.1b 프롬프트 구조 · 순위 판정 · 조율 흐름
- 첫 턴이나 정책이 바뀐 턴에만 전체 정책(`replyPolicy`)을 보내고, 평소에는 짧은 규칙(`coreRules`)만 보낸다. 매 턴 붙는 상태 블록에는 에이전트별 모델·노력·우선순위와 한도가 들어가고, 요청은 `Current request` 머리글로 표시된다. 에이전트가 태그에 이름을 쓰면 `normalizeTagTargets`가 id로 바꾼다.
- 순위 판정 모델은 JSON을 내고 에이전트를 이름으로 가리킨다. 한도가 0%인 에이전트와 **이름이 불리지 않은 임시 작업자(`sub_kind='task'`)**는 후보에서 빠진다. 상주 서브에이전트는 기본으로 후보에 들어간다.
- `/조율 …`·`/회의 …`로 시작하는 메시지는 판정을 건너뛰고 "각자 의견 → 조율 → 동시 작업"(`/회의`는 합의안까지만)으로 간다. 이 표시(`flowBySeq`)는 **메모리에만** 있어서 허브가 재시작되면 판정 전이던 메시지는 일반 메시지로 처리된다.
- 자동 순위 방에서 "각자 의견 내고 다 나오면 상의해" 식의 한 메시지 요청은, 의견을 낸 에이전트가 2명 이상일 때만 조율 라운드로 넘어간다.
- 병렬 답변이 여러 개면 마지막에 답한 에이전트가 정리(`maybeWrapUp`)를 맡는다.
- 임시 작업자의 답은 부모에게만 가는 개인 메시지(`recipient`)이며 방에서는 접혀 보인다. 부모가 보고를 처리한 턴이 끝나면 작업자가 정리된다. 서브에이전트의 답은 부모만 1순위로 깨운다.

## 3.2 제어 태그 (에이전트 응답 본문에서 파싱)
- **위치 규칙:** 태그는 응답의 어느 줄에든 **그 줄에 태그만 단독으로** 있으면 인식한다(첫 줄일 필요 없음). 문장 중간에 섞인 태그, 인용문·코드 블록 속 태그는 무시한다.
- `[[WORK: 제목]]` / `[[DONE]]` / `[[CONTINUE]]` / `[[WAIT: 이유]]`: 작업 진행 상태 표시 및 연속 턴/대기 제어.
- `[[CALL:이름]]`: 후속 에이전트 호출.
- `[[TO:이름]]`: 해당 에이전트에게만 1:1 전달.
- `[[AFTER:이름]]`: 지정한 에이전트가 턴을 끝낼 때 깨움(`registerPeerWaiter` / `wakePeerWaiters`).
- `[[SPAWN:cli/model:name:task]]`: 현재 에이전트 아래 서브에이전트 생성(부모당 최대 3개).
- `[[DELEGATE:name|task|files|doneCriteria]]`: **자기 밑의 상주 서브에이전트**에게 작업 카드 생성 및 지시 전달. 다른 에이전트에게 일을 맡기려면 작업 카드에서 담당자를 지정한다(담당자를 깨우는 처리는 `handoff.change`의 `onCreate`).
- `[[AGENT_ROOM_NO_REPLY]]`: 응답이 불필요할 때 출력(방에 저장하지 않음).

## 3.3 정책 자동 동기화 (`policyHash`)
- `hub.cjs`의 `cliTurn`은 `replyPolicy` 문자열로 `policyHash`를 계산해 `cli_sessions.policy_version`과 비교합니다.
- 정책 문구가 바뀌면 기존 세션에도 `(Room policy updated; it replaces the earlier one.)`와 함께 전체 `replyPolicy`를 자동 재전송합니다.

## 3.4 사용량 한도(`usage_limit`) 처리 및 경고
- `cliTurn`에서 `error.cliCode === 'usage_limit'` 발생 시 `recordQuotaLimit()`으로 쿨다운 시각을 기록하고 `last_cli_error`를 갱신합니다.
- 기존 경고가 없을 때(`!limitNotified.has(participant)` 및 직전 `last_cli_error`가 `usage_limit`이 아닐 때)만 채팅방에 경고 메시지를 1회 남기고, 정상 턴 완료 시 `limitNotified`를 초기화합니다.

> 상위 목차: [ARCHITECTURE.md](../../ARCHITECTURE.md)
