/**
 * Gemini ⇄ Streamline-MCP bridge.
 *
 * Drives the EXACT same tool registry the MCP server exposes to Claude
 * (`buildTools()` → `ToolDef[]`) with Google Gemini's function-calling
 * instead of the MCP transport. This is what powers the in-dashboard
 * "Streamline API" chat page: same 25 tools, same `VendorClient`, no
 * Claude / connector / OAuth in the loop — the dashboard already holds
 * the vendor's `/vendor/v1` bearer token, so we build a `VendorClient`
 * straight from it (see `chat-server.ts`).
 *
 * Flow per request:
 *   contents = [...history, latest user message]
 *   loop (bounded by maxHops):
 *     POST :generateContent { systemInstruction, contents, tools }
 *     if the model returned functionCall part(s):
 *        run each tool.handler, append the model turn + a functionResponse
 *        turn, and continue the loop
 *     else: return the model's text
 *
 * Gemini quirks handled here (verified empirically against
 * gemini-2.5-flash before this file was written):
 *  • Its function-declaration schema is an OpenAPI subset that REJECTS
 *    `additionalProperties` and `const` (both emitted by our
 *    `zod-to-jsonschema`), and accepts STRING-ONLY enums. We sanitise
 *    with a strict whitelist: string literals become a 1-value enum,
 *    numeric/boolean literals (the 0/1 flags everywhere in the vendor
 *    API) drop the constraint and keep just `type`, and a union that
 *    collapses to one shape is inlined to avoid a pointless `anyOf`.
 *  • A function whose parameter object is empty must OMIT `parameters`
 *    entirely (Gemini errors on `properties: {}`).
 *  • A `functionResponse.response` must be a JSON object — non-objects
 *    are wrapped as `{ result }`.
 *  • The model's function-call turn is echoed back VERBATIM so the
 *    `thoughtSignature` (2.5 thinking) is preserved across hops.
 */
import axios from 'axios';
import type { ToolDef } from './tools.js';
import { zodToJsonSchema } from './zod-to-jsonschema.js';

const GEMINI_HOST = 'https://generativelanguage.googleapis.com/v1beta';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** One tool invocation, surfaced to the UI so the vendor can see what ran. */
export interface ToolTrace {
  name: string;
  args: Record<string, any>;
  ok: boolean;
  error?: string;
}

export interface GeminiChatResult {
  reply: string;
  toolCalls: ToolTrace[];
  /** Which model produced the final reply (or the last one tried). */
  model?: string;
  /** True when every model in the rotation was rate-limited / unavailable. */
  exhausted?: boolean;
}

/**
 * Shown when EVERY model in the rotation is rate-limited. We surface this
 * gentle line instead of a raw 429 / quota stack-trace — per product
 * decision, "the service is busy" reads far better than the Google error.
 */
export const BUSY_MESSAGE =
  'الخدمة مشغولة حاليًا 🙏 كل النماذج المجانية وصلت حدّها المؤقت. جرّب بعد دقيقة.';

// Failed models rest: busy → a minute (or Google's retryDelay), hung → 3 min,
// daily quota spent → until the Pacific-midnight reset, retired → a day.
const cooldownUntil = new Map<string, number>();
const COOLDOWN_MS = 60_000;
const HUNG_COOLDOWN_MS = 3 * 60_000;
const GONE_COOLDOWN_MS = 24 * 60 * 60_000;
const CALL_TIMEOUT_MS = 20_000;
const noThinking = new Set<string>();
// Tool chats need a little planning: low thinking keeps them agentic without the slow default.
function thinkingFor(model: string): Record<string, unknown> {
  if (model.startsWith('gemma') || noThinking.has(model)) return {};
  if (model.startsWith('gemini-2.5')) return { thinkingConfig: { thinkingBudget: 512 } };
  return { thinkingConfig: { thinkingLevel: 'low' } };
}

function msUntilQuotaReset(): number {
  const pacific = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const reset = new Date(pacific);
  reset.setHours(24, 1, 0, 0);
  return reset.getTime() - pacific.getTime();
}

function cooldownFor(err: any): number {
  const status = err?.response?.status;
  const raw = err?.response?.data?.error?.details;
  const details: any[] = Array.isArray(raw) ? raw : [];
  if (details.some((d) => Array.isArray(d?.violations) && d.violations.some((v: any) => /PerDay/.test(String(v?.quotaId || ''))))) {
    return msUntilQuotaReset();
  }
  const retry = parseFloat(String(details.find((d) => String(d?.['@type'] || '').endsWith('RetryInfo'))?.retryDelay || ''));
  if (Number.isFinite(retry) && retry > 0) return retry * 1000 + 1000;
  if (status === 404) return GONE_COOLDOWN_MS;
  if (status === 429 || status >= 500) return COOLDOWN_MS;
  return err?.code === 'ECONNABORTED' ? HUNG_COOLDOWN_MS : 0;
}

/**
 * POST `:generateContent`, rotating down `models` (strongest first) on any failure.
 * `state.idx` persists across a conversation's tool round-trips; only when EVERY
 * model fails do we raise `ALL_MODELS_EXHAUSTED` (the caller shows BUSY_MESSAGE).
 */
async function callGemini(
  apiKey: string,
  models: string[],
  state: { idx: number; last: string },
  body: any,
): Promise<{ data: any; model: string }> {
  let lastErr: any = null;
  for (let i = state.idx; i < models.length; i++) {
    const model = models[i];
    if ((cooldownUntil.get(model) ?? 0) > Date.now()) continue;
    const url = `${GEMINI_HOST}/models/${encodeURIComponent(model)}:generateContent`;
    try {
      const res = await axios.post(
        url,
        { ...body, generationConfig: { ...body.generationConfig, ...thinkingFor(model) } },
        { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey }, timeout: CALL_TIMEOUT_MS },
      );
      state.idx = i;
      state.last = model;
      return { data: res.data, model };
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      const detail = err?.response?.data?.error?.message || err?.message || '';
      if (status === 400 && /thinking/i.test(String(detail)) && !noThinking.has(model)) {
        noThinking.add(model);
        i--;
        continue;
      }
      const rest = cooldownFor(err);
      if (rest > 0) cooldownUntil.set(model, Date.now() + rest);
      // eslint-disable-next-line no-console
      console.error(
        `[gemini] model "${model}" failed (status=${status ?? err?.code} ${String(detail).slice(0, 60)}) → resting ${Math.round(rest / 1000)}s, trying next`,
      );
      continue;
    }
  }
  const e: any = new Error('ALL_MODELS_EXHAUSTED');
  e.code = 'ALL_MODELS_EXHAUSTED';
  e.lastError = lastErr;
  throw e;
}

// ── Gemini schema sanitiser ─────────────────────────────────────
//
// Gemini's function-declaration schema is a SUBSET of OpenAPI 3.0. To
// avoid a 400 on any unexpected keyword we keep a strict whitelist of
// fields the planner actually needs and drop the rest. Runtime arg
// validation still happens against the original Zod schema in the tool
// handler, so dropping `minLength` / `pattern` / `additionalProperties`
// here costs us nothing — those constraints are re-enforced on execute.
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'description',
  'enum',
  'items',
  'properties',
  'required',
  'anyOf',
  'nullable',
  'format',
]);

function sanitizeSchema(node: any): any {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== 'object') return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    // `const` (from ZodLiteral). Gemini enums are STRING-ONLY, so we keep
    // a string literal as a 1-value enum but DROP numeric/boolean literals
    // (e.g. the 0/1 flags all over the vendor API) — `type` survives and
    // the handler's Zod schema re-validates the exact value on execute.
    if (k === 'const') {
      if (typeof v === 'string') {
        out.enum = Array.isArray(out.enum) ? [...out.enum, v] : [v];
      }
      continue;
    }
    if (!ALLOWED_SCHEMA_KEYS.has(k)) continue;
    if (k === 'enum') {
      // Only all-string enums are valid in a Gemini function declaration.
      if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
        out.enum = v;
      }
      continue;
    }
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, any> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, any>)) {
        props[pk] = sanitizeSchema(pv);
      }
      out.properties = props;
      continue;
    }
    if (k === 'items') {
      out.items = sanitizeSchema(v);
      continue;
    }
    if (k === 'anyOf') {
      // Sanitise each branch, drop empties, dedupe. A union that collapses
      // to a single distinct shape (e.g. number|number after numeric-enum
      // stripping) is inlined so Gemini doesn't choke on a pointless anyOf.
      const seen = new Set<string>();
      const uniq: any[] = [];
      for (const b of (v as any[]).map(sanitizeSchema)) {
        if (!b || (typeof b === 'object' && Object.keys(b).length === 0)) continue;
        const key = JSON.stringify(b);
        if (!seen.has(key)) {
          seen.add(key);
          uniq.push(b);
        }
      }
      if (uniq.length === 1) {
        Object.assign(out, uniq[0]);
      } else if (uniq.length > 1) {
        out.anyOf = uniq;
      }
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Convert a `ToolDef[]` into Gemini `functionDeclarations`. */
export function toolsToGeminiDeclarations(tools: ToolDef[]): any[] {
  return tools.map((t) => {
    const schema = sanitizeSchema(zodToJsonSchema(t.inputSchema));
    const decl: any = { name: t.name, description: t.description };
    const hasParams =
      schema && schema.properties && Object.keys(schema.properties).length > 0;
    // Gemini rejects an empty parameter object — omit it for no-arg tools.
    if (hasParams) decl.parameters = schema;
    return decl;
  });
}

// ── tool-result shaping ─────────────────────────────────────────
//
// Cap on how much of a single tool result we feed back to the model.
// Large list endpoints (200 employees, a month of bookings) would
// otherwise balloon the context window and the bill. The handler's
// result is still fully executed — we only trim what the MODEL sees.
const MAX_RESULT_CHARS = 14_000;

function toResponseObject(result: any): Record<string, any> {
  try {
    const json = JSON.stringify(result);
    if (json && json.length > MAX_RESULT_CHARS) {
      return {
        truncated: true,
        note: `Result truncated to ${MAX_RESULT_CHARS} characters. Ask for a narrower query (filters, a specific id, or a shorter period) if you need the full data.`,
        preview: json.slice(0, MAX_RESULT_CHARS),
      };
    }
  } catch {
    /* circular structure — fall through and wrap */
  }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result;
  }
  return { result };
}

/**
 * Best-effort cleanup of tool-call narration that weaker models (notably the
 * Gemma family) leak into the reply despite the system prompt — e.g.
 * "The `branch action=\"list\"` returned 3 branches: …". GUARDED: it only runs
 * when those markers are present, so clean Gemini replies pass through
 * untouched. Runtime arg validation is unaffected — this only shapes prose.
 */
function cleanReply(text: string): string {
  if (!text) return text;
  // Detect tool-call narration or visible chain-of-thought. Gemma tends to
  // "think" in English in the open output (e.g. "The user wants…", "From `…`",
  // "I will answer in Najdi…") before giving the real answer. Clean Gemini
  // replies have none of these markers and pass through untouched.
  const narrated =
    /`/.test(text) ||
    /\b(i['’]?ll|i will|i need|let me|the user|i have all|from the|in the response|returned\s+\d|action\s*=|najdi|present this|here['’]?s|here is|the answer is|final answer|as follows)\b/i.test(text);
  if (!narrated) return text;
  // Cut at the LAST English→Arabic hand-off: where the English reasoning ends
  // (a Latin letter … then `.`, `:` or newline) and the Arabic answer begins.
  // Internal English inside the answer (branch names like "30 Degrees") is
  // followed by markdown/space, not "[.:↵] + Arabic", so it won't match — only
  // the real reasoning→answer boundary does. Handles emojis/markdown/multiline.
  const boundary = /[A-Za-z][^؀-ۿ]*?[.:\n]\s*(?=[؀-ۿ])/g;
  let cut = -1;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(text)) !== null) cut = m.index + m[0].length;
  if (cut > 0) {
    const answer = text.slice(cut).trim();
    if (answer.length >= 4) return answer;
  }
  // No clean hand-off found — strip backtick tool snippets and return.
  return text.replace(/`[^`]*`/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Run one assistant turn: feed the conversation to Gemini, execute any
 * tools it asks for, and return the final natural-language reply plus a
 * trace of every tool that ran.
 */
export async function runGeminiChat(opts: {
  apiKey: string;
  models: string[];
  systemInstruction: string;
  tools: ToolDef[];
  messages: ChatMessage[];
  maxHops?: number;
}): Promise<GeminiChatResult> {
  const { apiKey, models, systemInstruction, tools } = opts;
  const maxHops = opts.maxHops ?? 8;
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const functionDeclarations = toolsToGeminiDeclarations(tools);

  const contents: any[] = opts.messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const toolCalls: ToolTrace[] = [];
  // Tracks which model in the rotation we're on; callGemini advances it as
  // models hit their (mostly per-minute) free-tier limit.
  const modelState = { idx: 0, last: models[0] };

  for (let hop = 0; hop < maxHops; hop++) {
    const body = {
      system_instruction: { parts: [{ text: systemInstruction }] },
      contents,
      tools: [{ functionDeclarations }],
      tool_config: { function_calling_config: { mode: 'AUTO' } },
      generationConfig: { temperature: 0.2 },
    };

    let data: any;
    try {
      const r = await callGemini(apiKey, models, modelState, body);
      data = r.data;
    } catch (err: any) {
      // Every model is rate-limited → return the gentle busy line (keeping
      // any tool traces gathered so far) instead of throwing a raw error.
      if (err && err.code === 'ALL_MODELS_EXHAUSTED') {
        return { reply: BUSY_MESSAGE, toolCalls, model: modelState.last, exhausted: true };
      }
      throw err;
    }

    const candidate = data?.candidates?.[0];
    const parts: any[] = candidate?.content?.parts ?? [];
    const fnParts = parts.filter((p) => p && p.functionCall);

    // No tool requested → this is the final answer.
    if (fnParts.length === 0) {
      const text = parts
        .filter((p) => typeof p?.text === 'string')
        .map((p) => p.text)
        .join('')
        .trim();
      return {
        reply: cleanReply(text) || 'ما قدرت أطلع لك رد. جرّب تعيد صياغة طلبك.',
        toolCalls,
        model: modelState.last,
      };
    }

    // Echo the model's function-call turn VERBATIM (keeps thoughtSignature).
    contents.push({ role: 'model', parts });

    // Execute every requested tool and collect their responses.
    const responseParts: any[] = [];
    for (const p of fnParts) {
      const name: string = p.functionCall.name;
      const args: Record<string, any> = p.functionCall.args ?? {};
      const tool = toolsByName.get(name);

      if (!tool) {
        toolCalls.push({ name, args, ok: false, error: 'unknown tool' });
        responseParts.push({
          functionResponse: { name, response: { error: `Unknown tool: ${name}` } },
        });
        continue;
      }

      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) {
        const error = parsed.error.issues
          .map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`)
          .join('; ');
        toolCalls.push({ name, args, ok: false, error });
        responseParts.push({
          functionResponse: {
            name,
            response: { error: `Invalid arguments: ${error}` },
          },
        });
        continue;
      }

      try {
        const result = await tool.handler(parsed.data);
        toolCalls.push({ name, args, ok: true });
        responseParts.push({
          functionResponse: { name, response: toResponseObject(result) },
        });
      } catch (err: any) {
        const error = err?.message ? String(err.message) : String(err);
        toolCalls.push({ name, args, ok: false, error });
        responseParts.push({
          functionResponse: { name, response: { error } },
        });
      }
    }

    contents.push({ role: 'user', parts: responseParts });
  }

  // Ran out of hops — return a graceful stop rather than looping forever.
  return {
    reply:
      'توقفت بعد عدة خطوات بدون ما أكمّل الطلب كامل. جرّب تبسّط الطلب أو تقسّمه لخطوات أصغر.',
    toolCalls,
    model: modelState.last,
  };
}
