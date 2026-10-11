#!/usr/bin/env node
/**
 * In-dashboard chat server for the "Streamline API" page.
 *
 * `POST /chat` → Gemini drives the Streamline MCP tools against the
 * LOGGED-IN vendor's own account, then replies in natural language.
 *
 * Auth model — DELIBERATELY simpler than `http-server.ts`'s OAuth:
 *   The dashboard is already authenticated and holds the vendor's
 *   `/vendor/v1` bearer token. It forwards that token in the
 *   `Authorization` header; we build a `VendorClient` straight from it.
 *   No OAuth, no Dynamic Client Registration, no token store. The token
 *   never leaves the vendor's own session → their own backend. This is
 *   why the page can live INSIDE the site instead of as an external
 *   claude.ai connector.
 *
 * Env:
 *   GEMINI_API_KEY        (required) — Google AI Studio key (AIza…).
 *   GEMINI_MODEL          (optional) — default `gemini-2.5-flash`.
 *   STREAMLINE_BASE       (optional) — vendor API base URL. Defaults to
 *                                      production; set to
 *                                      http://localhost:8010/vendor/v1
 *                                      for local dev.
 *   CHAT_PORT             (optional) — default 8011.
 *   HOST                  (optional) — default 0.0.0.0.
 *   CHAT_ALLOWED_ORIGINS  (optional) — comma-separated allow-list. When
 *                                      empty, any Origin is reflected
 *                                      (fine for local dev; lock it down
 *                                      in production).
 */
import express, { type Request, type Response } from 'express';
import { VendorClient } from './vendor-client.js';
import { buildTools } from './tools.js';
import { runGeminiChat, type ChatMessage } from './gemini-bridge.js';
import { nowSaudi } from './time.js';

const PORT = Number(process.env.CHAT_PORT) || 8011;
const HOST = process.env.HOST || '0.0.0.0';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Free-tier models, strongest first; 2.0 is shut down, 2.5 Pro closed to new users, 3.1 Pro paid-only.
const DEFAULT_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemma-4-26b-a4b-it',
  'gemma-4-31b-it',
];
// GEMINI_MODELS (comma-separated) overrides; GEMINI_MODEL kept for back-compat.
const MODELS = (process.env.GEMINI_MODELS || process.env.GEMINI_MODEL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const GEMINI_MODELS = MODELS.length > 0 ? MODELS : DEFAULT_MODELS;
const STREAMLINE_BASE = process.env.STREAMLINE_BASE; // undefined → VendorClient default (prod)

// ── Live AI config from the admin "Integrations" page ───────────────────────
// The admin dashboard manages the Gemini key + model list at
// /dashboard/admin/integrations (Laravel `integrations` table). When admin
// credentials are provided here, this service pulls that integration's
// (decrypted) credentials from the admin API at startup + on a timer, so an
// EDIT ON THE ADMIN PAGE drives this service live — no file edit/restart.
// Falls back to GEMINI_API_KEY / GEMINI_MODELS from .env.chat whenever the admin
// source is unavailable, unconfigured, or the integration is switched off.
const ADMIN_BASE = process.env.STREAMLINE_ADMIN_BASE || '';
const ADMIN_USER = process.env.STREAMLINE_ADMIN_USER || '';
const ADMIN_PASS = process.env.STREAMLINE_ADMIN_PASS || '';
const AI_CONFIG_REFRESH_MS = Number(process.env.AI_CONFIG_REFRESH_MS) || 5 * 60_000;
// How fresh the admin-page config must be on each /chat request. Without this,
// the only refresh was the 5-min heartbeat, so an edit on the admin page didn't
// reflect for up to 5 minutes — the AI kept using the previously-loaded key.
// A short TTL means each chat re-pulls if the config is older than this, so edits
// take effect within seconds. A refresh in flight is shared (no stampede).
const AI_CONFIG_TTL_MS = Number(process.env.AI_CONFIG_TTL_MS) || 5_000;

// Mutable runtime config — starts from env, overlaid by the admin page when available.
let activeKey = GEMINI_API_KEY;
let activeModels = GEMINI_MODELS;
let configSource = GEMINI_API_KEY ? '.env.chat' : 'none';
let lastConfigAttempt = 0; // timestamp of the last admin-config pull attempt
let inFlightRefresh: Promise<void> | null = null; // de-dupe concurrent refreshes

async function refreshAiConfigFromAdmin(): Promise<void> {
  if (!ADMIN_BASE || !ADMIN_USER || !ADMIN_PASS) return; // admin source not wired → keep env
  lastConfigAttempt = Date.now(); // mark the attempt up front (failures don't retry-storm)
  try {
    const loginRes = await fetch(`${ADMIN_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
    });
    const loginJson: any = await loginRes.json().catch(() => null);
    const adminToken = loginJson?.data?.access_token || loginJson?.data?.token;
    if (!adminToken) throw new Error('admin login returned no token');

    const intRes = await fetch(`${ADMIN_BASE}/integrations`, {
      headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' },
    });
    const intJson: any = await intRes.json().catch(() => null);
    const rows: any[] = Array.isArray(intJson?.data) ? intJson.data : [];
    // The Streamline AI integration (key 'gemini' / group 'ai'), only if active.
    const ai = rows.find((r) => r && (r.key === 'gemini' || r.group === 'ai') && r.is_active);
    const creds = ai?.credentials || {};
    const key = typeof creds.api_key === 'string' ? creds.api_key.trim() : '';
    const models = String(creds.models || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (key) {
      activeKey = key;
      activeModels = models.length > 0 ? models : GEMINI_MODELS;
      configSource = 'admin-integrations';
      // eslint-disable-next-line no-console
      console.error(
        `[chat] AI config from admin page (models=${activeModels.length}, key=…${key.slice(-4)})`,
      );
    } else {
      // Integration switched off / unconfigured → fall back to env.
      activeKey = GEMINI_API_KEY;
      activeModels = GEMINI_MODELS;
      configSource = GEMINI_API_KEY ? '.env.chat (admin integration empty/off)' : 'none';
    }
  } catch (err: any) {
    // Never break the service over the admin overlay — keep the current config.
    // eslint-disable-next-line no-console
    console.error(`[chat] admin AI-config refresh failed (${err?.message || err}) → keeping ${configSource}`);
  }
}

// Re-pull the admin config before a chat IF it's older than the TTL. Concurrent
// callers share a single in-flight refresh so a burst of chats triggers one pull.
async function ensureFreshConfig(): Promise<void> {
  if (!ADMIN_BASE || !ADMIN_USER || !ADMIN_PASS) return;
  if (Date.now() - lastConfigAttempt <= AI_CONFIG_TTL_MS) return;
  if (!inFlightRefresh) {
    inFlightRefresh = refreshAiConfigFromAdmin().finally(() => {
      inFlightRefresh = null;
    });
  }
  await inFlightRefresh;
}

const ALLOWED_ORIGINS = (process.env.CHAT_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// The assistant's persona + operating rules. Mirrors the Saudi-first,
// confirm-before-write conventions baked into the MCP tool catalogue.
const SYSTEM_INSTRUCTION = `You are "Streamline AI" — a friendly SAUDI in-dashboard assistant for a Saudi service-business vendor (barbershop / salon / similar) on the Streamline platform. You operate the vendor's OWN Streamline account through the provided tools.

LANGUAGE & IDENTITY
- You ARE Saudi. When the user writes Arabic, ALWAYS reply in natural Najdi Saudi dialect (لهجة نجدية سعودية) — warm and friendly, like a Saudi colleague. Use everyday Saudi words naturally (أبشر، حيّاك الله، تمام، الحين، وش ودّك، يا غالي) and AVOID stiff Modern Standard Arabic (الفصحى). Keep it concise and practical.
- If the user writes English, reply in English.

CONTEXT
- EVERY request is about THIS vendor's own account on the Streamline platform — never answer as a generic chatbot. When a message ends with a note such as "(هذا الطلب يخص حسابي في منصة Streamline)", take it as a reminder to use the Streamline tools and answer from the vendor's real account data.

LOCALE & MONEY
- Currency is the Saudi Riyal (SAR / ريال). Format amounts with Western digits and thousands separators (e.g. 1,234 ريال).
- Timezone is Asia/Riyadh (UTC+3, no daylight saving). For anything relative to "today", "now", "this week/month", call get_current_time FIRST — never assume the date.

USING TOOLS
- Prefer tools over guessing. For any question about the vendor's real data (revenue, bookings, services, sections, employees, customers, branches, offers, promo codes, wallet, invoices, calendar, reminders, settings, reviews…), call the relevant tool and answer ONLY from the result. Never invent numbers, names, or ids.
- This rule covers EXAMPLES too: never write a branch / service / employee / customer / offer name that did NOT come back from a tool call in THIS conversation — not even as a "for example". A vendor's branches might be named anything; guessing a plausible name (e.g. «فرع النخيل») is a BUG, because that branch may not exist. If you're about to mention any such name, you must have fetched it from a tool first.
- Several resources are "umbrella" tools that take an "action" field (e.g. booking, service, employee, offer, branch, section, promo_code, role, reminder, account). Read each tool's description for which fields each action needs.
- You may chain tools: e.g. list to find an id, then act on it. Resolve names → ids yourself via the list/get tools rather than asking the user for an id.

MEMORY
- The SHOP MEMORY below holds the owner's numbered standing preferences; follow them. When the owner's message changed the memory, a "(ذاكرة: …)" note at its end says exactly what was saved or removed: confirm it in one short line.
- Never claim you saved, changed or forgot something unless that note (or a successful ai_memory call) says so. If the owner wants something remembered and nothing was saved, save it with ai_memory.
- Talk to the owner the way they talk (their dialect, tone and phrases), as described in the memory.

WRITES & SAFETY
- Read actions: perform them freely.
- Write actions (create / update / cancel / complete / reschedule / activate / deactivate / change settings): if the user's request is clear and explicit, do it, then confirm what changed. If anything important is ambiguous (which branch, which customer, price, time), briefly confirm the key details FIRST instead of guessing.
- Deletions are intentionally unavailable; use activate/deactivate instead.

STYLE
- NEVER mention tool or function names, and do NOT narrate the API calls you made (don't write things like \`branch action="list"\`). Just answer naturally in the user's language as if you already knew the data.
- When you need the vendor to choose among their OWN records (a branch, service, employee, customer, offer…): FIRST call the matching list tool, THEN present ONLY the exact names it returned as the options, then ask. Never ask "which branch?" with a made-up sample — always show the real list. If the answer doesn't actually need a specific record (e.g. "most-requested service this month" works across ALL branches), just answer for everything by default and only drill into one branch if the vendor asks.
- If a tool returns an error, explain it simply and suggest the next step. Don't expose raw stack traces.`;

// Appended to the END of the latest user message before each request (see the
// CONTEXT section of SYSTEM_INSTRUCTION). Grounds the model — especially the
// weaker Gemma fallbacks — in "this is a question about my Streamline account".
const STREAMLINE_CONTEXT_SUFFIX =
  '\n\n(هذا الطلب يخص حسابي في منصة Streamline — استخدم أدوات Streamline وجاوب من بيانات حسابي.)';

const BUSY_REPLY = 'تعذّر تشغيل المساعد حاليًا 🙏 جرّب بعد قليل.';

function memoryNote(memory?: Memory | null): string {
  if (memory?.remembered) {
    return memory.replaced
      ? `(ذاكرة: حفظت «${memory.remembered}» بدل «${memory.replaced}».)`
      : `(ذاكرة: حفظت «${memory.remembered}».)`;
  }
  return memory?.forgotten ? `(ذاكرة: حذفت «${memory.forgotten}».)` : '';
}
const MAX_HISTORY = 16;
const MAX_USER_CHARS = 1000;
const MAX_REPLY_CHARS = 2000;
const MAX_HOPS = 6;

type Usage = { used: number; limit: number };
type Memory = { remembered?: string; replaced?: string | null; forgotten?: string };
type Turn = { context: string; usage?: Usage; memory?: Memory | null } | { status: number; reply: string };

// The backend gates the assistant (package feature + daily/minute limits) and hands back the shop memory.
async function startTurn(api: VendorClient, lang: string, message?: string): Promise<Turn> {
  try {
    const data: any = await api.post('/ai/chat-turn', message ? { message } : {}, {
      headers: { 'Accept-Language': lang },
      timeoutMs: 30_000,
    });
    return { context: String(data?.context || ''), usage: data?.usage, memory: data?.memory ?? null };
  } catch (err: any) {
    if (err?.status === 404) return { context: '' };
    const known = [401, 403, 429].includes(err?.status);
    return { status: known ? err.status : 503, reply: known ? String(err?.raw?.message || BUSY_REPLY) : BUSY_REPLY };
  }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// ── CORS ────────────────────────────────────────────────────────
// The vendor token travels in the Authorization header (NOT a cookie),
// so we don't need credentialed CORS — reflecting the origin without
// `Allow-Credentials` is safe. Lock down via CHAT_ALLOWED_ORIGINS in prod.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  } else if (!origin && ALLOWED_ORIGINS.length === 0) {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.header('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    models: activeModels,
    hasKey: Boolean(activeKey),
    configSource,
    base: STREAMLINE_BASE || 'default (production)',
  });
});

// Force an immediate re-pull of the AI config from the admin page (ops/testing).
app.post('/refresh-config', async (_req: Request, res: Response) => {
  await refreshAiConfigFromAdmin();
  res.json({ ok: true, models: activeModels, hasKey: Boolean(activeKey), configSource });
});

app.post('/chat', async (req: Request, res: Response) => {
  // Pull the latest admin-page config (key + models) if it's stale, so an edit on
  // /dashboard/admin/integrations takes effect within seconds — not after the
  // 5-minute heartbeat. (No-op when the cached config is fresher than the TTL.)
  await ensureFreshConfig();

  if (!activeKey) {
    res.status(500).json({ error: 'Gemini API key is not configured (admin page or .env.chat).' });
    return;
  }

  // Vendor token: Authorization header preferred; body.token as a fallback.
  const authHeader = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = m ? m[1].trim() : typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) {
    res
      .status(401)
      .json({ error: 'Missing vendor token. Send it as `Authorization: Bearer <token>`.' });
    return;
  }

  const rawMessages: any[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const messages: ChatMessage[] = rawMessages
    .filter(
      (x) =>
        x &&
        (x.role === 'user' || x.role === 'assistant') &&
        typeof x.content === 'string' &&
        x.content.trim(),
    )
    .slice(-MAX_HISTORY)
    .map((x) => ({
      role: x.role,
      content: String(x.content).slice(0, x.role === 'user' ? MAX_USER_CHARS : MAX_REPLY_CHARS),
    }));
  while (messages.length > 0 && messages[0].role !== 'user') messages.shift();

  if (messages.length === 0) {
    res
      .status(400)
      .json({ error: 'Body must include messages[] of { role: "user"|"assistant", content: string }.' });
    return;
  }

  const last = messages[messages.length - 1];
  const typed = req.body?.typed !== false && last?.role === 'user' ? last.content : undefined;

  // Pin the latest request to the Streamline context by appending the hint to
  // the END of the most recent user message (weaker models weight the tail most).
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      messages[i] = { role: 'user', content: messages[i].content + STREAMLINE_CONTEXT_SUFFIX };
      break;
    }
  }

  const stream = String(req.headers.accept || '').includes('text/event-stream');
  let closed = false;
  res.on('close', () => {
    if (!res.writableEnded) closed = true;
  });
  const emit = (event: string, data: unknown) => {
    if (stream && !closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const finish = (payload: unknown) => {
    if (!res.headersSent) {
      res.json(payload);
      return;
    }
    emit('done', payload);
    res.end();
  };

  try {
    const api = new VendorClient({ token, baseURL: STREAMLINE_BASE });
    const lang = req.body?.lang === 'en' || req.body?.lang === 'tr' ? req.body.lang : 'ar';
    const turn = await startTurn(api, lang, typed);
    if ('status' in turn) {
      res.status(turn.status).json({ reply: turn.reply, toolCalls: [], limited: turn.status === 429 });
      return;
    }
    const note = memoryNote(turn.memory);
    if (note) {
      const at = messages.length - 1;
      messages[at] = { ...messages[at], content: `${messages[at].content}\n${note}` };
    }
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      emit('step', { name: 'thinking' });
    }
    const tools = buildTools(api);
    const now = nowSaudi();
    const result = await runGeminiChat({
      apiKey: activeKey,
      models: activeModels,
      systemInstruction:
        `${SYSTEM_INSTRUCTION}\n\nNOW (Asia/Riyadh): ${now.date} ${now.time}, ${now.weekday_ar}. Use it for today/this week/this month without asking.` +
        (turn.context
          ? `\n\nSHOP MEMORY (facts about this shop and the owner's standing preferences; follow them, and keep them current with ai_memory when the owner states a new lasting preference or asks to drop one):\n${turn.context}`
          : ''),
      tools,
      messages,
      maxHops: MAX_HOPS,
      onStep: (step) => emit('step', step),
      isCancelled: () => closed,
    });
    finish({ ...result, usage: turn.usage, memory: turn.memory || undefined });
  } catch (err: any) {
    const status = err?.response?.status;
    const gemError = err?.response?.data?.error;
    // eslint-disable-next-line no-console
    console.error(
      `[chat] error status=${status ?? '?'} ${JSON.stringify(gemError || err?.message || String(err)).slice(0, 600)}`,
    );
    // Never surface a raw error/stack to the UI. Respond 200 with a gentle
    // line so the page shows a calm "try again" bubble, not a red 5xx.
    finish({
      reply: BUSY_REPLY,
      toolCalls: [],
      unavailable: true,
    });
  }
});

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.error(
    `[streamline-chat] listening on http://${HOST}:${PORT}  (env models=${GEMINI_MODELS.length}, base=${STREAMLINE_BASE || 'production'}, admin overlay=${ADMIN_BASE ? 'on' : 'off'})`,
  );
  // Overlay the admin-page-managed key/models, then keep them fresh so an edit
  // on /dashboard/admin/integrations takes effect without restarting this service.
  void refreshAiConfigFromAdmin();
  if (ADMIN_BASE && ADMIN_USER && ADMIN_PASS) {
    setInterval(() => void refreshAiConfigFromAdmin(), AI_CONFIG_REFRESH_MS);
  }
});
