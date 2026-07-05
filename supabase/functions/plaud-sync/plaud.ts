// ─────────────────────────────────────────────────────────────────────────────
// Plaud 접근 어댑터 (유일한 '미확정' 부분)
//
// 나머지 파이프라인(Claude 추출 · Google Calendar 등록)은 확정이고, 여기 두 함수만
// 실제 Plaud 데이터 형식에 맞추면 된다. 확정 방법 3가지(택1):
//   (a) [권장] Plaud 웹훅을 한 번 쏴서 index.ts의 PLAUD_WEBHOOK_RAW 로그로 실제 JSON을
//       확인 → parseWebhook의 필드 매핑만 맞춘다.
//   (b) 옛 봇 스크립트가 있으면 그 안의 web.plaud.ai API 호출을 그대로 옮긴다.
//   (c) web.plaud.ai 로그인 상태에서 네트워크 탭의 목록/상세 API를 캡처해 옮긴다.
//
// 아래는 공개 정보(파일 URL https://web.plaud.ai/file/<id>, 세션 JWT 방식)에 기반한
// '합리적 기본값'이며, 실제 응답으로 검증 후 필드명을 확정한다.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaudMeeting {
  id: string; // Plaud 파일 id (https://web.plaud.ai/file/<id> 의 <id>)
  title: string; // 원본 제목
  folder: string; // 폴더명(없으면 "(미분류)")
  startISO: string; // 녹음 시작 시각 ISO8601
  durationMin: number; // 길이(분)
  transcript: string; // 전사 텍스트
  summary: string; // Plaud가 만든 요약(있으면)
}

// 웹훅 페이로드 → PlaudMeeting. 실제 형식 확인 후 매핑 확정(TODO).
export function parseWebhook(body: any): PlaudMeeting | null {
  // Plaud 웹훅은 transcript_ready / summary_ready 등 이벤트로 온다고 알려져 있음.
  // 흔한 래핑 형태들을 방어적으로 흡수한다.
  const d = body?.data ?? body?.file ?? body?.payload ?? body;
  const id = d?.id ?? d?.file_id ?? d?.fileId ?? body?.file_id;
  if (!id) return null;
  return {
    id: String(id),
    title: d?.title ?? d?.name ?? "(제목 없음)",
    folder: d?.folder ?? d?.folder_name ?? d?.tag ?? "(미분류)",
    startISO: d?.start_time ?? d?.recorded_at ?? d?.created_at ?? new Date().toISOString(),
    durationMin: Math.max(1, Math.round((d?.duration ?? d?.duration_sec ?? 60) / 60)) || 1,
    transcript: d?.transcript ?? d?.transcription ?? d?.content ?? "",
    summary: d?.summary ?? d?.ai_summary ?? d?.notes ?? "",
  };
}

// 폴링 모드: 세션 토큰으로 최근 파일 목록을 가져와 미처리분을 PlaudMeeting[]로 반환.
// TODO(확정): web.plaud.ai 내부 목록/상세 엔드포인트를 실제 값으로 교체.
//   - 목록:  GET https://api.plaud.ai/... (Authorization: Bearer <PLAUD_TOKEN>)
//   - 상세/전사: GET https://api.plaud.ai/.../{id}/transcript
// 아래는 자리표시자. 실제 응답 스키마 확인 전까지는 빈 배열을 반환해 안전하게 no-op.
export async function fetchRecentMeetings(token: string): Promise<PlaudMeeting[]> {
  const BASE = Deno.env.get("PLAUD_API_BASE") ?? ""; // 예: https://api.plaud.ai
  const LIST_PATH = Deno.env.get("PLAUD_LIST_PATH") ?? ""; // 예: /v2/files?limit=20
  if (!BASE || !LIST_PATH) {
    console.warn("PLAUD_API_BASE/PLAUD_LIST_PATH 미설정 — 폴링 no-op. 웹훅 경로 사용 권장.");
    return [];
  }
  const res = await fetch(`${BASE}${LIST_PATH}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // 401/403 → 토큰 만료(옛 봇이 멈춘 것과 동일 증상). 웹훅으로 전환 권장.
    console.error(`Plaud list ${res.status}: ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  const files = data?.files ?? data?.items ?? data?.data ?? [];
  return files.map((f: any) => parseWebhook(f)).filter(Boolean) as PlaudMeeting[];
}
