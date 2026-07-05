# Plaud 자동화 되살리기 — 활성화 가이드 (서버리스 A안)

옛 봇은 **사장님 PC + 만료되는 web.plaud.ai 세션 토큰**에 의존했고, 그래서 6/17경 조용히
멈췄습니다. 이 버전은 **항상 켜진 Supabase Edge Function**으로 옮겨 그 문제를 없앱니다.

```
Plaud 새 녹음 ──(웹훅)──▶ Supabase Edge Function(plaud-sync)
                              │  Claude로 제목 정리 + 📌할일(담당자·마감일) 추출
                              ▼
                        Google Calendar 자동 등록
                        · 회의  [Plaud] MM-DD 제목 (폴더)  — 폴더 색상
                        · 할일  📌 요약 (담당자)          — 마감 종일 + 하루 전 알림
                        (plaud_id / plaud_todo 로 중복 방지)
```

코드는 `supabase/functions/plaud-sync/` 에 있습니다. 배포처는 기존 활성 프로젝트
**`dasibom`** (Supabase). 비밀값은 전부 시크릿으로 주입 → 공개 저장소에 노출 없음.

---

## 사장님이 준비할 것 (딱 3가지)

### ① Anthropic(Claude) API 키  — 회의요약·할일 추출용
- <https://console.anthropic.com> → API Keys → 새 키 발급 → 키 문자열 확보.
- 비용: 회의 1건당 대략 수십 원 수준(모델 `claude-sonnet-5` 기준). 소액.

### ② Google 서비스계정 + 캘린더 공유  — 함수가 캘린더에 쓰기 위해
헤드리스로 캘린더에 쓰려면 함수 전용 '로봇 계정'이 필요합니다.
1. <https://console.cloud.google.com> → 프로젝트 생성(아무 이름).
2. **API 및 서비스 → 라이브러리 → "Google Calendar API" 사용 설정.**
3. **API 및 서비스 → 사용자 인증 정보 → 서비스 계정 만들기** → 이름 아무거나 → 완료.
4. 만든 서비스계정 → **키 → 키 추가 → JSON** → `.json` 파일 다운로드.
   (이 파일 통째 문자열이 시크릿 `GOOGLE_SERVICE_ACCOUNT_JSON` 값)
5. JSON 안의 `client_email`(…@….iam.gserviceaccount.com) 복사.
6. **Google 캘린더(웹) → 내 캘린더 설정 → "특정 사용자와 공유" → 그 client_email 추가 →
   권한 "변경 및 관리"** 로 설정. ← 이게 있어야 로봇이 일정 등록 가능.

> 더 간단한 대안: GCP가 번거로우면 **Apps Script 웹앱**(내 계정으로 실행되는 15줄 스크립트)
> 방식으로 바꿔드릴 수 있습니다. 말씀만 주세요.

### ③ Plaud에서 데이터 빼오는 방법  — 아래 중 하나 확인
- **(권장) 웹훅**: Plaud 설정에 **Webhook / 개발자 / 연동** 항목이 있는지 확인.
  있으면 배포 후 제가 드리는 함수 URL을 넣으면 끝(토큰 만료 무관, 실시간).
- **웹훅이 없으면**: web.plaud.ai 로그인 세션 토큰(JWT)을 시크릿 `PLAUD_TOKEN`으로 주고
  스케줄 폴링으로 돌립니다(단, 토큰은 주기적 갱신 필요 — 옛 봇의 약점).
- **가속기(선택)**: 옛 봇 스크립트가 PC에 남아 있으면 보내주세요. 그 안의 web.plaud.ai
  API 호출을 그대로 옮기면 폴링도 견고해집니다.

---

## 배포 (제가 MCP로 수행 — 사장님은 위 3개만 주시면 됩니다)

1. `dasibom`에 마이그레이션 적용 → `plaud_processed`(중복방지) 테이블 생성.
2. Edge Function `plaud-sync` 배포.
3. 시크릿 주입:
   | 시크릿 | 값 |
   |---|---|
   | `CLAUDE_API_KEY` | ① 키 |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | ② JSON 통문자열 |
   | `GOOGLE_CALENDAR_ID` | `ksnap87@gmail.com` |
   | `WEBHOOK_SECRET` | 임의 문자열(웹훅 검증용) |
   | `PLAUD_TOKEN` | (폴링 시에만) |
4. 함수 URL 확인 → Plaud 웹훅에 등록 **또는** 폴링용 cron 설정.

## 검증
- Plaud 웹훅 1회 발사 → 함수 로그의 `PLAUD_WEBHOOK_RAW`로 실제 페이로드 확인 →
  필요 시 `plaud.ts`의 필드 매핑 미세조정.
- 구글 캘린더에 `[Plaud]` 회의 + `📌` 할일이 5/19 배치와 동일한 모양으로 뜨는지 확인.
- 정상 확인 후, 밀린 최근 녹음 백필.

## 안전장치
- 처리한 회의는 `plaud_processed`에 기록 → **중복 등록 없음**.
- 캘린더 이벤트 설명에 `plaud_id=` / `plaud_todo=` 키 포함 → 옛 배치와 동일 규칙.
- 시크릿은 코드가 아니라 Supabase 시크릿에만 존재.
