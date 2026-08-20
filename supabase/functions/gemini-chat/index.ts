/**
 * Supabase Edge Function: gemini-chat
 *
 * Public web chat endpoint. The Gemini key is kept only in Supabase Secrets.
 * Do NOT put GEMINI_API_KEY in GitHub or browser code.
 *
 * Required secret:
 *   GEMINI_API_KEY
 * Optional secret:
 *   ALLOWED_ORIGIN (defaults to the MokuWood GitHub Pages origin)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const GEMINI_MODEL = "gemini-3.5-flash-lite";
const ALLOWED_ORIGIN =
  Deno.env.get("ALLOWED_ORIGIN") ??
  "https://star13141313-alt.github.io";

const MAX_HISTORY_ITEMS = 20;
const MAX_TEXT_LENGTH = 500;
const MAX_BODY_BYTES = 30_000;

const SYSTEM_PROMPT =
  "你是「肆木代購 MokuWood.co」的 AI 客服助理。" +
  "請使用繁體中文回覆，語氣親切、簡潔。" +
  "只能回答與肆木代購相關的問題，例如代購流程、商品進度、訂單、付款、寄送、取件與賣貨便。" +
  "不要捏造商品庫存、價格、訂單狀態、付款結果或任何你無法確認的資訊。" +
  "如果需要查詢個人訂單或無法確定答案，請建議顧客聯絡官方 LINE：@wrg3112r。";

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const rateMap = new Map<string, { count: number; resetAt: number }>();

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Vary": "Origin",
    },
  });
}

function isAllowedOrigin(origin: string | null): boolean {
  return origin === ALLOWED_ORIGIN;
}

function getClientKey(req: Request): string {
  // Deno Deploy/Supabase may provide this header. It is only used for
  // best-effort abuse limiting; it is NOT an authentication mechanism.
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  const current = rateMap.get(key);

  if (!current || now >= current.resetAt) {
    rateMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  if (current.count >= RATE_LIMIT) return true;
  current.count += 1;
  return false;
}

function validateHistory(input: unknown) {
  if (!Array.isArray(input)) return null;
  if (input.length === 0 || input.length > MAX_HISTORY_ITEMS) return null;

  const history = input
    .filter((item): item is { role: "user" | "model"; parts: [{ text: string }] } => {
      if (!item || typeof item !== "object") return false;
      const value = item as Record<string, unknown>;
      if (value.role !== "user" && value.role !== "model") return false;
      if (!Array.isArray(value.parts) || value.parts.length !== 1) return false;
      const part = value.parts[0];
      if (!part || typeof part !== "object") return false;
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" && text.trim().length > 0 && text.length <= MAX_TEXT_LENGTH;
    })
    .map((item) => ({
      role: item.role,
      parts: [{ text: item.parts[0].text.trim() }],
    }));

  if (history.length !== input.length) return null;
  if (history[history.length - 1].role !== "user") return null;

  return history;
}

serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("origin");

  // Never allow a non-MokuWood web origin to use this endpoint.
  if (!isAllowedOrigin(origin)) {
    return jsonResponse({ error: "Forbidden origin" }, 403, origin);
  }

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405, origin);
  }

  if (rateLimited(getClientKey(req))) {
    return jsonResponse(
      { error: "Too many requests. Please try again later." },
      429,
      origin,
    );
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Request too large" }, 413, origin);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return jsonResponse({ error: "AI service is not configured" }, 500, origin);
  }

  let body: { history?: unknown };
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return jsonResponse({ error: "Request too large" }, 413, origin);
    }
    body = JSON.parse(raw) as { history?: unknown };
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, origin);
  }

  const history = validateHistory(body.history);
  if (!history) {
    return jsonResponse({ error: "Invalid chat history" }, 400, origin);
  }

  const geminiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const geminiPayload = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: history,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 300,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ],
  };

  try {
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload),
    });

    if (!geminiRes.ok) {
      console.error("Gemini API error:", geminiRes.status);
      return jsonResponse(
        { error: "AI service temporarily unavailable" },
        502,
        origin,
      );
    }

    const geminiData = await geminiRes.json();
    const reply =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (typeof reply !== "string" || !reply.trim()) {
      return jsonResponse(
        { error: "AI returned no usable response" },
        502,
        origin,
      );
    }

    return jsonResponse({ reply: reply.trim() }, 200, origin);
  } catch (error) {
    console.error("Edge function error:", error);
    return jsonResponse({ error: "Internal server error" }, 500, origin);
  }
});
