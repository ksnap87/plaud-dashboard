---
description: Plaud 새 녹음을 읽어 회의 요약·할일을 Google Calendar에 자동 등록
---

# /plaud-sync — Plaud → Google Calendar 동기화

이 명령은 Plaud의 새 녹음을 읽어 회의·할일을 사장님(ksnap87@gmail.com) 캘린더에
2026-05-19 배치와 동일한 형식으로 등록한다. 어느 Claude Code 세션에서든 실행 가능.

## 전제 (커넥터 2개)
- **plaud** MCP (`https://mcp.plaud.ai/mcp`) — 저장소 `.mcp.json`으로 로드됨. 도구가 안 보이거나
  "requires authentication"이면 사용자에게 claude.ai 커넥터 설정에서 Plaud 재인증을 요청하고 중단.
- **Google Calendar** MCP — 이미 연결됨.
- Plaud 쪽 **Private Cloud Sync(PCS)** 가 켜져 있어야 함.

## 절차
1. **이미 등록된 회의 파악 (중복 방지)**
   - `list_events(calendarId="ksnap87@gmail.com", fullText="plaud_id", startTime=최근 60일)` 로
     기존 `[Plaud]` 이벤트를 모아 description의 `plaud_id=<id>` 집합을 만든다.
2. **새 녹음 목록**
   - `mcp__plaud__list_files` (필요시 `date_from`). 아래는 **제외**:
     - 개인 통화(`통화`/`통화 녹음`), 짧은 음성메모(`음성 …`), 60초 미만 잡음, `How to use Plaud`.
   - 이미 집합에 있는 `plaud_id` 는 건너뜀.
3. **각 새 회의 처리**
   - `mcp__plaud__get_note(file_id)` 로 요약·액션아이템을 읽는다.
   - **회의 이벤트** 생성:
     - `summary`: `[Plaud] MM-DD <정리된 제목>` (폴더가 (미분류) 아니면 뒤에 ` (폴더)`)
     - `startTime`/`endTime`: Plaud `start_at`은 **UTC** → **+9h = KST**. `timeZone="Asia/Seoul"`.
       종료 = 시작 + `duration(ms)/60000`분.
     - `colorId`: 폴더별(그룹장님9·CE팀장님회의7·손익분석10·프라이싱5·감사제6·패넷epp3·이맥스2·갤캠스4), 기본 `8`.
     - `description`:
       ```
       폴더: <폴더>
       길이: <N>분

       대시보드: https://ksnap87.github.io/plaud-dashboard/#meeting-<id>
       plaud_id=<id>
       ```
   - **할일 이벤트** (담당자가 **스티브 / Steve(사장님 본인)** 인 액션아이템만, 각각):
     - ⚠️ 다른 담당자(@Speaker N, 지원팀 리드, 국장 등) 액션은 **캘린더에 등록하지 않음** —
       회의 이벤트 기록으로만 남기고 대시보드에 회의별 개수로만 표시. (2026-07-14 사장님 확정)
     - `summary`: `📌 <20자내 요약> (스티브)`
     - all-day: `allDay=true`, 마감일(명시/추론된 YYYY-MM-DD, 없으면 회의 날짜), `timeZone="Asia/Seoul"`
     - `colorId="11"`, `overrideReminders=[{method:"popup",minutes:1440}]` (하루 전)
     - `description`:
       ```
       담당: 스티브
       폴더: <폴더> (출처: MM-DD <제목>)

       원문: <액션 원문>

       대시보드: https://ksnap87.github.io/plaud-dashboard/
       plaud_todo=<id>-<순번>
       ```
4. **보고**: 새로 등록한 회의 수·**스티브 할일 수**를 사용자에게 요약(다른 담당자 액션 개수는 참고로만 언급). 없으면 "새 녹음 없음".

## 참고
- 중복 방지는 `plaud_id`(회의)/`plaud_todo`(할일) 키로만 판단 — 이 키를 반드시 description에 넣을 것.
- 대량이면 배치로 나눠 생성. 실패한 create_event는 재시도.
- 완전 무인(스케줄) 실행은 Plaud OAuth 재인증 이슈로 불안정할 수 있음 → 이 명령을 수동/루틴으로 돌리는 것을 권장.
  진짜 무인이 필요하면 `supabase/functions/plaud-sync/`(PR #1)에 Plaud 개발자 API를 연결하는 경로가 대안.
