/**
 * Supabase Edge Function: gemini-chat
 *
 * Security-first chat endpoint backed by Supabase Auth + DB.
 *
 * Auth flow:
 *   1. Client must present a valid Supabase JWT (anonymous or regular user).
 *   2. The conversation_id in the body must belong to the authenticated user.
 *   3. Chat history is read from the DB (never trusted from the client).
 *   4. AI reply is written to chat_messages via service_role.
 *
 * Auto-injected Supabase secrets (no configuration needed):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   SUPABASE_ANON_KEY
 *
 * Required user secret (set with `supabase secrets set`):
 *   GEMINI_API_KEY
 *
 * Optional user secret:
 *   ALLOWED_ORIGIN  (defaults to the MokuWood GitHub Pages origin)
 *
 * Do NOT put GEMINI_API_KEY or SUPABASE_SERVICE_ROLE_KEY in
 * GitHub, browser code, or any public file.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";

// ── Constants ─────────────────────────────────────────────────
const GEMINI_MODEL = "gemini-2.0-flash-lite";
const ALLOWED_ORIGIN =
  Deno.env.get("ALLOWED_ORIGIN") ?? "https://star13141313-alt.github.io";

const MAX_HISTORY_MESSAGES = 20; // messages fetched from DB for context
const MAX_MESSAGE_LENGTH   = 500;
const MAX_BODY_BYTES       = 4_096; // body is now tiny: only conversation_id

const SYSTEM_PROMPT =
  "你是「肆木代購 MokuWood.co」的 AI 客服助理。" +
  "請使用繁體中文回覆，語氣親切、簡潔。" +
  "只能回答與肆木代購相關的問題，例如代購流程、商品進度、訂單、付款、寄送、取件與賣貨便。" +
  "不要捏造商品庫存、價格、訂單狀態、付款結果或任何你無法確認的資訊。" +
  "如果需要查詢個人訂單或無法確定答案，請建議顧客聯絡官方 LINE：@wrg3112r。";

// In-memory rate limiter keyed by Supabase user_id (resets on cold start)
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT     = 10;
const rateMap = new Map<string, { count: number; resetAt: number }>();

// ── Helpers ───────────────────────────────────────────────────
function corsHeaders(allowOrigin: string) {
  return {
    "Access-Control-Allow-Origin":  allowOrigin,
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  const allow = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null";
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type":  "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(allow),
    },
  });
}

function isAllowedOrigin(origin: string | null): boolean {
  return origin === ALLOWED_ORIGIN;
}

function rateLimited(userId: string): boolean {
  const now     = Date.now();
  const current = rateMap.get(userId);
  if (!current || now >= current.resetAt) {
    rateMap.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  if (current.count >= RATE_LIMIT) return true;
  current.count += 1;
  return false;
}

function isValidUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

// ── Main handler ──────────────────────────────────────────────
serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  // Block all non-MokuWood origins before anything else
  if (!isAllowedOrigin(origin)) {
    return jsonResponse({ error: "Forbidden origin" }, 403, origin);
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(ALLOWED_ORIGIN),
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405, origin);
  }

  // ── 1. Verify Supabase JWT ────────────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  const jwt        = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!jwt) {
    return jsonResponse({ error: "Unauthorized: missing token" }, 401, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey     = Deno.env.get("SUPABASE_ANON_KEY");

  if (!supabaseUrl || !serviceKey || !anonKey) {
    console.error("Missing Supabase env vars");
    return jsonResponse({ error: "Server misconfiguration" }, 500, origin);
  }

  // Create a user-scoped client to verify the JWT and get the user id
  const userClient: SupabaseClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth:   { persistSession: false },
  });

  const { data: { user }, error: authErr } = await userClient.auth.getUser();

  if (authErr || !user) {
    return jsonResponse({ error: "Unauthorized: invalid session" }, 401, origin);
  }

  const userId = user.id;

  // ── 2. Rate limit by user id ──────────────────────────────
  if (rateLimited(userId)) {
    return jsonResponse(
      { error: "Too many requests. Please try again later." },
      429,
      origin,
    );
  }

  // ── 3. Parse & validate request body ─────────────────────
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Request too large" }, 413, origin);
  }

  let body: { conversation_id?: unknown };
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return jsonResponse({ error: "Request too large" }, 413, origin);
    }
    body = JSON.parse(raw) as { conversation_id?: unknown };
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, origin);
  }

  if (!isValidUuid(body.conversation_id)) {
    return jsonResponse({ error: "Invalid conversation_id" }, 400, origin);
  }

  const conversationId = body.conversation_id;

  // ── 4. Verify conversation belongs to this user ───────────
  // Use service_role so RLS does not block our lookup
  const adminClient: SupabaseClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const { data: conv, error: convErr } = await adminClient
    .from("chat_conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (convErr || !conv) {
    return jsonResponse({ error: "Conversation not found" }, 404, origin);
  }

  // ── 5. Fetch recent chat history from DB ──────────────────
  const { data: messages, error: msgErr } = await adminClient
    .from("chat_messages")
    .select("sender_type, message")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(MAX_HISTORY_MESSAGES);

  if (msgErr) {
    console.error("DB read error:", msgErr);
    return jsonResponse({ error: "Could not load chat history" }, 500, origin);
  }

  if (!messages || messages.length === 0) {
    return jsonResponse({ error: "No messages found in conversation" }, 400, origin);
  }

  // Validate last message is from user and within length limit
  const lastMsg = messages[messages.length - 1];
  if (lastMsg.sender_type !== "user") {
    return jsonResponse({ error: "Last message must be from user" }, 400, origin);
  }
  if (lastMsg.message.length > MAX_MESSAGE_LENGTH) {
    return jsonResponse({ error: "Message too long" }, 400, origin);
  }

  // Build Gemini-format history
  const geminiHistory = messages.map((m) => ({
    role:  m.sender_type === "user" ? "user" : "model",
    parts: [{ text: m.message }],
  }));

  // ── 6. Call Gemini API ────────────────────────────────────
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return jsonResponse({ error: "AI service is not configured" }, 500, origin);
  }

  const geminiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}` +
    `:generateContent?key=${encodeURIComponent(apiKey)}`;

  const geminiPayload = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: geminiHistory,
    generationConfig: {
      temperature:    0.4,
      maxOutputTokens: 300,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH",        threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",  threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT",  threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ],
  };

  let reply: string;
  try {
    const geminiRes = await fetch(geminiUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(geminiPayload),
    });

    if (!geminiRes.ok) {
      console.error("Gemini API error:", geminiRes.status);
      return jsonResponse({ error: "AI service temporarily unavailable" }, 502, origin);
    }

    const geminiData = await geminiRes.json();
    const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (typeof text !== "string" || !text.trim()) {
      return jsonResponse({ error: "AI returned no usable response" }, 502, origin);
    }

    reply = text.trim();
  } catch (err) {
    console.error("Gemini fetch error:", err);
    return jsonResponse({ error: "Internal server error" }, 500, origin);
  }

  // ── 7. Persist AI reply to DB (service_role bypasses RLS) ─
  const { error: insertErr } = await adminClient
    .from("chat_messages")
    .insert({
      conversation_id: conversationId,
      sender_type:     "ai",
      message:         reply,
    });

  if (insertErr) {
    // Non-fatal: return reply anyway so the user sees the response,
    // but log the error for investigation.
    console.error("Failed to save AI reply:", insertErr);
  }

  return jsonResponse({ reply }, 200, origin);
});
