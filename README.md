# Plaud Dashboard

Plaud 녹음 → 회의록 정리 + 할일/일정 자동 등록 파이프라인.

## 구성
- `index.html` — 암호화(staticrypt) 대시보드 "Plaud 업무 비서" (GitHub Pages 배포).
- `plaud.ics` — 회의·액션 캘린더 파일.
- `supabase/functions/plaud-sync/` — **되살린 자동화(서버리스)**. Plaud 새 녹음을
  웹훅/폴링으로 받아 Claude로 회의 제목 정리 + 📌할일(담당자·마감일) 추출 후 Google
  Calendar에 자동 등록. 옛 "PC + 만료 토큰" 방식의 취약점을 없앤 항상-켜진 버전.

## 되살리기(활성화)
`docs/plaud-revival-SETUP.md` 참고 — 필요한 것은 딱 3가지: Claude API 키, Google
서비스계정+캘린더 공유, Plaud 웹훅(또는 세션 토큰).
