// ─────────────────────────────────────────────────────────────────────────────
// plaud-sync  ·  Supabase Edge Function (Deno)
//
// "항상 켜진 서버리스"로 Plaud 자동화를 되살리는 함수.
//   Plaud 새 녹음(웹훅 또는 스케줄 폴링)
//     → Claude로 회의 제목 정리 + 📌할일(담당자·마감일) 추출
//     → Google Calendar에 등록 (2026-05-19 배치와 '동일 형식')
//        · 회의: [Plaud] MM-DD 제목 (폴더)  — 폴더별 색상, 실제 녹음 시각
//        · 할일: 📌 요약 (담당자)          — 마감일 종일 일정, 하루 전 팝업 알림
//     → plaud_id / plaud_todo 키로 중복 등록 방지
//
// 시크릿(환경변수)로 주입 — 코드에 비밀값 없음(공개 저장소 안전):
//   CLAUDE_API_KEY                 Anthropic API 키
//   GOOGLE_SERVICE_ACCOUNT_JSON    구글 서비스계정 키 JSON(문자열 전체)
//   GOOGLE_CALENDAR_ID             기본 'ksnap87@gmail.com'
//   WEBHOOK_SECRET                 Plaud 웹훅 검증용 공유 비밀(선택)
//   PLAUD_TOKEN                    폴링 모드에서 web.plaud.ai 접근용 세션 토큰(선택)
//   CLAUDE_MODEL                   기본 'claude-sonnet-5'
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (플랫폼이 자동 주입)
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "jsr:@supabase/supabase-js@2";
import { fetchRecentMeetings, parseWebhook, type PlaudMeeting } from "./plaud.ts";

const CLAUDE_API_KEY = Deno.env.get("CLAUDE_API_KEY") ?? "";
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5";
const CALENDAR_ID = Deno.env.get("GOOGLE_CALENDAR_ID") ?? "ksnap87@gmail.com";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? "";
const PLAUD_TOKEN = Deno.env.get("PLAUD_TOKEN") ?? "";
const DASHBOARD_URL = "https://ksnap87.github.io/plaud-dashboard";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
);

// 폴더 → 캘린더 colorId. 2026-05-19 배치에서 관찰된 값과 동일.
// (미지정 폴더는 기본색. 할일은 항상 11=토마토.)
const FOLDER_COLOR: Record<string, string> = {
  "그룹장님": "9",
  "CE팀장님회의": "7",
  "손익분석": "10",
  "프라이싱": "5",
  "감사제": "6",
  "패넷epp": "3",
  "이맥스": "2",
  "갤캠스": "4",
};
const DEFAULT_MEETING_COLOR = "8";
const TODO_COLOR = "11";

// ── HTTP 진입점 ───────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/.*plaud-sync/, "") || "/";

  try {
    // 헬스체크
    if (req.method === "GET" && (path === "/" || path === "/health")) {
      return json({ ok: true, service: "plaud-sync" });
    }

    // 1) Plaud 웹훅 수신 (실시간, 토큰 만료 걱정 없음 — 권장 경로)
    if (req.method === "POST" && (path === "/" || path === "/webhook")) {
      if (WEBHOOK_SECRET) {
        const got = req.headers.get("x-webhook-secret") ??
          url.searchParams.get("secret") ?? "";
        if (got !== WEBHOOK_SECRET) return json({ error: "unauthorized" }, 401);
      }
      const body = await req.json().catch(() => ({}));
      // 페이로드 원본을 로그로 남겨 실제 형식을 확정한다(최초 1회 확인용).
      console.log("PLAUD_WEBHOOK_RAW", JSON.stringify(body));
      const meeting = parseWebhook(body);
      if (!meeting) {
        return json({ ok: true, skipped: "no meeting in payload" });
      }
      const result = await processMeeting(meeting);
      return json({ ok: true, ...result });
    }

    // 2) 스케줄 폴링 (웹훅을 못 쓰는 경우의 대안 — Supabase cron이 호출)
    if (req.method === "POST" && path === "/poll") {
      if (!PLAUD_TOKEN) return json({ error: "PLAUD_TOKEN 미설정" }, 400);
      const meetings = await fetchRecentMeetings(PLAUD_TOKEN);
      const results = [];
      for (const m of meetings) results.push(await processMeeting(m));
      return json({ ok: true, scanned: meetings.length, results });
    }

    return json({ error: "not found", path }, 404);
  } catch (e) {
    console.error("PLAUD_SYNC_ERROR", e);
    return json({ error: String(e?.message ?? e) }, 500);
  }
});

// ── 한 회의 처리: 추출 → 캘린더 등록 → 중복방지 기록 ─────────────────────────────
async function processMeeting(m: PlaudMeeting) {
  // 이미 처리한 회의면 건너뜀
  const { data: seen } = await supabase
    .from("plaud_processed")
    .select("plaud_id")
    .eq("plaud_id", m.id)
    .maybeSingle();
  if (seen) return { plaud_id: m.id, skipped: "already processed" };

  const extracted = await extractWithClaude(m);
  const token = await getGoogleAccessToken();

  // (1) 회의 이벤트
  const start = new Date(m.startISO);
  const end = new Date(start.getTime() + (m.durationMin || 1) * 60_000);
  const folder = m.folder || "(미분류)";
  const mmdd = kstMMDD(start);
  await createEvent(token, {
    summary: `[Plaud] ${mmdd} ${extracted.cleanTitle}${folder !== "(미분류)" ? ` (${folder})` : ""}`,
    description:
      `폴더: ${folder}\n길이: ${m.durationMin}분\n\n대시보드: ${DASHBOARD_URL}/#meeting-${m.id}\nplaud_id=${m.id}`,
    start: { dateTime: toKstISO(start), timeZone: "Asia/Seoul" },
    end: { dateTime: toKstISO(end), timeZone: "Asia/Seoul" },
    colorId: FOLDER_COLOR[folder] ?? DEFAULT_MEETING_COLOR,
  });

  // (2) 할일(액션아이템) 이벤트 — 마감일 종일 + 하루 전 팝업 알림
  let todoCount = 0;
  for (const a of extracted.actionItems) {
    const todoKey = `${m.id}-${todoCount}`;
    const due = a.dueDate ? new Date(`${a.dueDate}T00:00:00+09:00`) : start;
    const dueEnd = new Date(due.getTime() + 24 * 3600_000);
    await createEvent(token, {
      summary: `📌 ${a.shortSummary}${a.assignee ? ` (${a.assignee})` : ""}`,
      description:
        `담당: ${a.assignee || "미지정"}\n폴더: ${folder} (출처: ${mmdd} ${extracted.cleanTitle})\n\n원문: ${a.originalText}\n\n대시보드: ${DASHBOARD_URL}/\nplaud_todo=${todoKey}`,
      start: { date: kstYMD(due) },
      end: { date: kstYMD(dueEnd) },
      colorId: TODO_COLOR,
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 1440 }] },
    });
    todoCount++;
  }

  await supabase.from("plaud_processed").insert({
    plaud_id: m.id,
    title: extracted.cleanTitle,
    todo_count: todoCount,
  });

  return { plaud_id: m.id, title: extracted.cleanTitle, todos: todoCount };
}

// ── Claude로 제목 정리 + 할일 추출 (구조화 출력 강제) ───────────────────────────
type Extraction = {
  cleanTitle: string;
  actionItems: {
    shortSummary: string; // 캘린더 제목용 짧은 문구
    assignee: string; // 담당자(없으면 "")
    dueDate: string | null; // YYYY-MM-DD, 불명확하면 null
    originalText: string; // 회의에서 언급된 원문 액션
  }[];
};

async function extractWithClaude(m: PlaudMeeting): Promise<Extraction> {
  const meetingDate = m.startISO.slice(0, 10);
  const sys =
    `너는 한국어 회의록에서 (1) 간결한 회의 제목과 (2) 실행 액션아이템을 뽑는 비서다.\n` +
    `- 제목: 25자 내외, 핵심만. 날짜/[Plaud] 접두어는 붙이지 마라.\n` +
    `- 액션아이템: 실제로 '누가 무엇을 하기로 한' 것만. 단순 정보공유/의견은 제외.\n` +
    `- shortSummary: 20자 내외 명령형 요약. assignee: 발화/맥락상 담당자(없으면 빈 문자열).\n` +
    `- dueDate: 마감이 명시/추론되면 YYYY-MM-DD(회의일 ${meetingDate} 기준 상대표현 해석), 불명확하면 null.\n` +
    `- 반드시 emit_extraction 도구로만 답한다.`;
  const userText =
    `회의일: ${meetingDate}\n폴더: ${m.folder}\n제목(원본): ${m.title}\n\n` +
    `요약:\n${(m.summary || "").slice(0, 6000)}\n\n전사(일부):\n${(m.transcript || "").slice(0, 12000)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: sys,
      tool_choice: { type: "tool", name: "emit_extraction" },
      tools: [{
        name: "emit_extraction",
        description: "정리된 회의 제목과 액션아이템 목록",
        input_schema: {
          type: "object",
          properties: {
            cleanTitle: { type: "string" },
            actionItems: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  shortSummary: { type: "string" },
                  assignee: { type: "string" },
                  dueDate: { type: ["string", "null"] },
                  originalText: { type: "string" },
                },
                required: ["shortSummary", "assignee", "dueDate", "originalText"],
              },
            },
          },
          required: ["cleanTitle", "actionItems"],
        },
      }],
      messages: [{ role: "user", content: userText }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const toolUse = data.content?.find((c: any) => c.type === "tool_use");
  const out = toolUse?.input as Extraction;
  return {
    cleanTitle: out?.cleanTitle || m.title,
    actionItems: Array.isArray(out?.actionItems) ? out.actionItems : [],
  };
}

// ── Google 서비스계정 → OAuth 액세스 토큰 (RS256 JWT 서명) ──────────────────────
let cachedToken: { token: string; exp: number } | null = null;
async function getGoogleAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const sa = JSON.parse(Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON") ?? "{}");
  if (!sa.client_email) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON 미설정");

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${b64urlBytes(new Uint8Array(sig))}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google token ${res.status}: ${await res.text()}`);
  const tok = await res.json();
  cachedToken = { token: tok.access_token, exp: Date.now() + tok.expires_in * 1000 };
  return tok.access_token;
}

async function createEvent(accessToken: string, event: Record<string, unknown>) {
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(event),
    },
  );
  if (!res.ok) throw new Error(`Calendar insert ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── 작은 유틸 ─────────────────────────────────────────────────────────────────
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
// KST(+09:00) 기준 날짜 조각들
const KST = 9 * 3600_000;
function kstMMDD(d: Date) {
  const k = new Date(d.getTime() + KST);
  return `${String(k.getUTCMonth() + 1).padStart(2, "0")}-${String(k.getUTCDate()).padStart(2, "0")}`;
}
function kstYMD(d: Date) {
  const k = new Date(d.getTime() + KST);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, "0")}-${String(k.getUTCDate()).padStart(2, "0")}`;
}
function toKstISO(d: Date) {
  const k = new Date(d.getTime() + KST);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())}T${p(k.getUTCHours())}:${p(k.getUTCMinutes())}:${p(k.getUTCSeconds())}+09:00`;
}
function b64url(s: string) {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlBytes(bytes: Uint8Array) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemToArrayBuffer(pem: string) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
