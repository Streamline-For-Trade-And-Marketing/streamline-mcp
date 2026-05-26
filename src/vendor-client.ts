/**
 * HTTP client for the Streamline vendor API.
 *
 * Mirrors the mobile app's `vendorApi` instance — same base URL,
 * Bearer-token auth, and Arabic-first `Accept-Language` so the data
 * Claude sees matches what the user sees in their app. The mobile app
 * intentionally forces Arabic at the API layer (see the mobile repo's
 * CLAUDE.md §3.6 + §13.8) because most service names are authored in
 * Arabic only and several suppression rules key off literal Arabic
 * strings; copying that decision here keeps the two surfaces in sync.
 *
 * Rate limiting: the backend enforces 60 req/min globally per token,
 * so we cap our own throughput one notch below (50/min) to leave room
 * for the mobile app pinging from the same account. Requests beyond
 * the cap queue and resolve in order — never silent-drop.
 */
import axios, { AxiosError, AxiosInstance } from 'axios';

const DEFAULT_BASE = 'https://api.streamline.com.sa/vendor/v1';
// One notch below the backend's 60/min cap so a Claude conversation
// running alongside an open mobile app doesn't 429 either of them.
const RATE_LIMIT_PER_MIN = 50;
const WINDOW_MS = 60_000;

/**
 * Recursively append a value to a FormData under `key`.
 *
 * Handles three shapes that Laravel's request bag expects:
 *
 *   • scalar → `key=value`
 *   • flat array of scalars → `key[]=v1`, `key[]=v2`, …
 *   • array of objects → `key[idx][subkey]=value` for every leaf
 *   • nested object → `key[subkey]=value`
 *
 * Why this matters: the vendor Branch/Employee/Service endpoints
 * require `official_hours`, `break_hours`, and `home_hours` as an
 * array of `{day, start_time, end_time}` objects. The old encoder
 * called `String(item)` on each object, which yielded the literal
 * "[object Object]" — Laravel rejected the payload with a confusing
 * "must be an array" message. This recursive walker produces the
 * canonical PHP-style shape that Laravel parses back into structured
 * data.
 *
 * Null/undefined values are skipped so callers can pass through
 * sparsely-populated payloads without having to pre-clean them.
 */
function appendFormValue(
  fd: FormData,
  key: string,
  value: any,
  debugFields?: string[],
): void {
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      if (item === undefined || item === null) return;
      if (
        typeof item === 'object' &&
        !(item instanceof Blob) &&
        !(typeof File !== 'undefined' && item instanceof File)
      ) {
        for (const [ik, iv] of Object.entries(item)) {
          appendFormValue(fd, `${key}[${idx}][${ik}]`, iv, debugFields);
        }
      } else {
        const flat = `${key}[]`;
        fd.append(flat, String(item));
        if (debugFields) debugFields.push(`${flat}=${item}`);
      }
    });
    return;
  }

  if (
    typeof value === 'object' &&
    !(value instanceof Blob) &&
    !(typeof File !== 'undefined' && value instanceof File)
  ) {
    for (const [sk, sv] of Object.entries(value)) {
      appendFormValue(fd, `${key}[${sk}]`, sv, debugFields);
    }
    return;
  }

  fd.append(key, String(value));
  if (debugFields) debugFields.push(`${key}=${value}`);
}

class TokenBucket {
  private timestamps: number[] = [];
  private waiting: Array<() => void> = [];

  /** Resolves once a slot is available within the per-minute window. */
  async take(): Promise<void> {
    while (true) {
      const now = Date.now();
      // Drop entries older than the window — they don't count toward
      // the current capacity anymore.
      this.timestamps = this.timestamps.filter((t) => now - t < WINDOW_MS);
      if (this.timestamps.length < RATE_LIMIT_PER_MIN) {
        this.timestamps.push(now);
        return;
      }
      // Sleep until the OLDEST in-window entry expires, then re-check.
      const oldest = this.timestamps[0];
      const waitMs = WINDOW_MS - (now - oldest) + 5;
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }
}

/**
 * Result of probing the vendor's ZATCA registration. `active` is true
 * only when the vendor is BOTH registered AND has the phase-2 toggle
 * on — matches the mobile app's `useZatcaActive` gate. When `active`
 * is false, the platform does NOT issue tax invoices and any VAT
 * numbers the backend pre-computes for line items are noise we must
 * not surface to the vendor (they'd misread it as "I owe ZATCA").
 */
export interface ZatcaState {
  active: boolean;
  /** Raw backend response — kept so callers can debug if needed. */
  raw?: any;
}

export class VendorClient {
  private axios: AxiosInstance;
  private bucket = new TokenBucket();
  // ZATCA state is cached for the MCP process lifetime. The vendor
  // registers / activates rarely (it's a one-time onboarding step),
  // so the savings on the per-tool round-trip are worth missing a
  // mid-session flip — the next process restart catches up.
  private zatcaCache: Promise<ZatcaState> | null = null;

  constructor(opts: { baseURL?: string; token: string }) {
    if (!opts.token) {
      throw new Error(
        'STREAMLINE_TOKEN is required. Set it in the MCP server environment.',
      );
    }
    this.axios = axios.create({
      baseURL: opts.baseURL || DEFAULT_BASE,
      timeout: 20_000,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        // Arabic-first — see the comment block at the top of this file.
        'Accept-Language': 'ar',
        Accept: 'application/json',
      },
    });
  }

  /**
   * GET helper. Returns the unwrapped `data` payload from the standard
   * success envelope (`{ success, data, message }`). Use `getRaw` if
   * you need the full envelope (e.g. to read `meta`).
   */
  async get<T = any>(path: string, params?: Record<string, any>): Promise<T> {
    await this.bucket.take();
    try {
      const res = await this.axios.get(path, { params });
      return (res.data?.data ?? res.data) as T;
    } catch (err) {
      throw this.normaliseError(err);
    }
  }

  async getRaw(path: string, params?: Record<string, any>): Promise<any> {
    await this.bucket.take();
    try {
      const res = await this.axios.get(path, { params });
      return res.data;
    } catch (err) {
      throw this.normaliseError(err);
    }
  }

  /**
   * POST helper. Defaults to JSON body — most write endpoints in the
   * vendor API accept multipart with `_method=PUT`, but JSON works for
   * the activate/deactivate / cancel-style operations we use in the
   * MCP layer. Pass `{ multipart: true }` to switch to FormData.
   *
   * Multipart encoding supports nested arrays-of-objects via the
   * standard `key[idx][subkey]` shape that Laravel's request bag
   * parses back into `array<string, mixed>`. This unlocks the
   * `official_hours`, `break_hours`, and `home_hours` payloads that
   * the vendor Branch/Employee/Service endpoints require.
   */
  async post<T = any>(
    path: string,
    body?: Record<string, any>,
    opts: { multipart?: boolean } = {},
  ): Promise<T> {
    await this.bucket.take();
    try {
      let payload: any = body;
      let headers: Record<string, string> = {};
      if (opts.multipart && body) {
        const fd = new FormData();
        const debugFields: string[] = [];
        for (const [k, v] of Object.entries(body)) {
          if (v === undefined || v === null) continue;
          appendFormValue(fd, k, v, debugFields);
        }
        // Opt-in debug — set STREAMLINE_DEBUG=1 in the env to see
        // exactly what the MCP is sending. Kept after the walk-in
        // bug diagnosis because the same hook will help us when the
        // next opaque "validation failed" error comes back.
        if (process.env.STREAMLINE_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(`[streamline-mcp] POST ${path} fields: ${debugFields.join(' | ')}`);
        }
        payload = fd;
        headers['Content-Type'] = 'multipart/form-data';
      }
      const res = await this.axios.post(path, payload, { headers });
      return (res.data?.data ?? res.data) as T;
    } catch (err) {
      throw this.normaliseError(err);
    }
  }

  /**
   * DELETE helper. Used for soft-delete and hard-delete endpoints on
   * the vendor API. The MCP intentionally does NOT expose DELETE tools
   * to Claude — keeping this method here only so future maintenance
   * (e.g. internal admin scripts that share the same client) can use
   * it without re-implementing the rate-limit + error normalisation.
   */
  async delete<T = any>(path: string): Promise<T> {
    await this.bucket.take();
    try {
      const res = await this.axios.delete(path);
      return (res.data?.data ?? res.data) as T;
    } catch (err) {
      throw this.normaliseError(err);
    }
  }

  /** Hidden-method PUT — the Laravel pattern the mobile app uses. */
  async putViaPost<T = any>(
    path: string,
    body: Record<string, any>,
    opts: { multipart?: boolean } = {},
  ): Promise<T> {
    return this.post<T>(path, { ...body, _method: 'PUT' }, opts);
  }

  /**
   * Probe `/zatca` once per MCP process and cache the result.
   *
   * Backend response shape: `{ registered: 0|1, active: 0|1, ... }`.
   * The mobile app treats `registered === 1 && active === 1` as "tax
   * invoices are real" — we mirror that exactly. Anything else (no
   * ZATCA record at all, registered but not activated, etc.) means
   * the platform is in non-VAT mode and we must not show tax numbers
   * to the vendor.
   *
   * Cached as a Promise so the second caller waits on the same fetch
   * rather than firing a duplicate request.
   */
  async getZatcaState(): Promise<ZatcaState> {
    if (!this.zatcaCache) {
      this.zatcaCache = (async () => {
        try {
          const data = await this.get<any>('/zatca');
          const registered = Number(data?.registered ?? 0) === 1;
          const active = Number(data?.active ?? 0) === 1;
          return { active: registered && active, raw: data };
        } catch {
          // 404 or 403 — vendor has no ZATCA record at all. Treat
          // as not-active. Don't bubble the error: callers should
          // proceed with stripped VAT, not refuse to return data.
          return { active: false };
        }
      })();
    }
    return this.zatcaCache;
  }

  private normaliseError(err: unknown): Error {
    if (axios.isAxiosError(err)) {
      const ax = err as AxiosError<any>;
      const status = ax.response?.status;
      const data = ax.response?.data;
      const message = data?.message || ax.message || 'Request failed';
      const validation = data?.errors
        ? `\nValidation: ${JSON.stringify(data.errors)}`
        : '';
      const e = new Error(
        `Streamline API ${status ?? 'ERR'} on ${ax.config?.method?.toUpperCase()} ${ax.config?.url}: ${message}${validation}`,
      );
      (e as any).status = status;
      (e as any).raw = data;
      return e;
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
