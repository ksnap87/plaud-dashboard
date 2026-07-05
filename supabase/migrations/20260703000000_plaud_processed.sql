-- plaud-sync 중복 등록 방지 테이블
-- 한 번 캘린더에 등록한 Plaud 회의는 여기 기록해 재처리하지 않는다.
create table if not exists public.plaud_processed (
  plaud_id     text primary key,
  title        text,
  todo_count   int  default 0,
  processed_at timestamptz default now()
);

-- 서비스 롤(Edge Function)만 접근. 공개 접근 차단.
alter table public.plaud_processed enable row level security;
