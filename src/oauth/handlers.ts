/**
 * OAuth 2.1 endpoint handlers — `/oauth/register`, `/oauth/authorize`,
 * `/oauth/token`.
 *
 * Flow recap (PKCE authorization-code, the only one we support):
 *
 *   1. Claude calls POST /oauth/register with a name + redirect URIs.
 *      We mint a client_id (no secret — public client) and return it.
 *
 *   2. Claude opens a browser to GET /oauth/authorize?
 *        response_type=code
 *        &client_id=mcp_xxx
 *        &redirect_uri=https://claude.ai/...
 *        &code_challenge=...
 *        &code_challenge_method=S256
 *        &state=...
 *      We render the Streamline login page.
 *
 *   3. User submits the form. POST /oauth/authorize runs the
 *      Streamline /api/v1/login call. On success we store
 *      `request_id → vendor_token` in memory just long enough to
 *      issue the auth code, then 302 back to the redirect_uri with
 *      `?code=...&state=...`.
 *
 *   4. Claude POSTs /oauth/token with the code + code_verifier. We
 *      verify PKCE, look up the stored vendor_token, issue an
 *      access_token (1h) + refresh_token (30d) bound to the same
 *      vendor_token, and return them.
 *
 *   5. Every /mcp call from Claude carries
 *      `Authorization: Bearer at_xxx`. The MCP middleware looks up
 *      the access_token, pulls the vendor_token, and constructs a
 *      per-request VendorClient.
 *
 *   6. When the access_token expires, Claude posts the refresh_token
 *      to /oauth/token (grant_type=refresh_token). We rotate the
 *      refresh and issue a fresh access — vendor never re-logs in
 *      until the refresh itself expires.
 */
import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { OauthStore } from './store.js';
import { renderLoginPage } from './login-page.js';
import {
  loginToStreamline,
  loginToStreamlineWithCode,
  sendStreamlineLoginCode,
  StreamlineAuthError,
  type StreamlineLoginResult,
} from './streamline-auth.js';

/**
 * In-memory map of `request_id → pending authorize parameters`.
 *
 * When the vendor first lands on the login page we have a full
 * authorize request to remember (client_id, redirect_uri, PKCE
 * challenge, state). Persisting it server-side under a short opaque
 * id keeps the form HTML small and stops the vendor from being able
 * to tamper with the redirect target by editing hidden form fields.
 *
 * Entries auto-expire after 10 minutes — the login form is usually
 * filled in under 1.
 */
interface PendingAuthorize {
  client_id: string;
  redirect_uri: string;
  state: string | null;
  scope: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  created_at: number;
}
const pending = new Map<string, PendingAuthorize>();
const PENDING_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) {
    if (now - v.created_at > PENDING_TTL_MS) pending.delete(k);
  }
}, 60_000).unref();

export function makeOauthHandlers(store: OauthStore) {
  return {
    /**
     * Dynamic Client Registration (RFC 7591). Anyone can POST here
     * to register — we don't do client approval. The returned
     * client_id is bound to the redirect_uris provided so it can't
     * later be reused to phish via a different callback.
     */
    register(req: Request, res: Response): void {
      const { client_name, redirect_uris } = req.body || {};
      if (
        !Array.isArray(redirect_uris) ||
        redirect_uris.length === 0 ||
        redirect_uris.some((u) => typeof u !== 'string')
      ) {
        // eslint-disable-next-line no-console
        console.error(
          `[oauth/register] 400 invalid_redirect_uri name="${client_name}" redirects=${JSON.stringify(redirect_uris)}`,
        );
        res
          .status(400)
          .json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris[] required' });
        return;
      }
      const client = store.registerClient(
        typeof client_name === 'string' ? client_name : 'Unknown MCP client',
        redirect_uris,
      );
      // eslint-disable-next-line no-console
      console.error(
        `[oauth/register] 201 client_id=${client.client_id} name="${client.client_name}" redirects=${JSON.stringify(client.redirect_uris)}`,
      );
      // RFC 7591 §3.2.1 — return the client info.
      res.status(201).json({
        client_id: client.client_id,
        client_id_issued_at: client.created_at,
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    },

    /**
     * GET /oauth/authorize — render the Streamline login page.
     * Validates the OAuth params first; on any client error we
     * 400 inline rather than redirect (RFC 6749 §4.1.2.1) because
     * we can't trust a bad redirect_uri.
     */
    authorizeGet(req: Request, res: Response): void {
      const {
        response_type,
        client_id,
        redirect_uri,
        state,
        scope,
        code_challenge,
        code_challenge_method,
      } = req.query as Record<string, string | undefined>;

      // eslint-disable-next-line no-console
      console.error(
        `[oauth/authorize:GET] client_id=${client_id} redirect_uri=${redirect_uri} response_type=${response_type} scope="${scope || ''}" challenge_method=${code_challenge_method || '(none)'} ALL_QUERY=${JSON.stringify(req.query)}`,
      );

      if (response_type !== 'code') {
        // eslint-disable-next-line no-console
        console.error(`[oauth/authorize:GET] 400 unsupported response_type=${response_type}`);
        res.status(400).type('html').send(errorPage('Only response_type=code is supported.'));
        return;
      }
      if (!client_id) {
        // eslint-disable-next-line no-console
        console.error(`[oauth/authorize:GET] 400 missing client_id`);
        res.status(400).type('html').send(errorPage('Missing client_id.'));
        return;
      }
      const client = store.getClient(client_id);
      if (!client) {
        // eslint-disable-next-line no-console
        console.error(`[oauth/authorize:GET] 400 unknown client_id=${client_id}`);
        res.status(400).type('html').send(errorPage('Unknown client.'));
        return;
      }
      if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
        // eslint-disable-next-line no-console
        console.error(
          `[oauth/authorize:GET] 400 redirect_uri="${redirect_uri}" not in registered ${JSON.stringify(client.redirect_uris)}`,
        );
        res
          .status(400)
          .type('html')
          .send(errorPage('redirect_uri not registered for this client.'));
        return;
      }
      // PKCE — Claude always sends S256. We accept "plain" too for
      // dev-time curl testing but log a warning if it ever happens.
      if (code_challenge && !['S256', 'plain'].includes(code_challenge_method || 'plain')) {
        // eslint-disable-next-line no-console
        console.error(
          `[oauth/authorize:GET] 400 unsupported challenge_method=${code_challenge_method}`,
        );
        res.status(400).type('html').send(errorPage('Unsupported code_challenge_method.'));
        return;
      }

      const request_id = randomBytes(16).toString('hex');
      pending.set(request_id, {
        client_id,
        redirect_uri,
        state: state ?? null,
        scope: scope || 'vendor',
        code_challenge: code_challenge ?? null,
        code_challenge_method: code_challenge_method ?? null,
        created_at: Date.now(),
      });

      res
        .status(200)
        .type('html')
        .send(
          renderLoginPage({
            request_id,
            client_name: client.client_name,
          }),
        );
    },

    /**
     * POST /oauth/authorize — handle the login form.
     */
    async authorizePost(req: Request, res: Response): Promise<void> {
      const { request_id, username, password, step, code } = req.body || {};
      const session = typeof request_id === 'string' ? pending.get(request_id) : null;
      if (!session) {
        // eslint-disable-next-line no-console
        console.error(
          `[oauth/authorize:POST] 400 missing/expired session request_id=${request_id}`,
        );
        res
          .status(400)
          .type('html')
          .send(
            errorPage(
              'الجلسة منتهية الصلاحية. من فضلك ارجع لـ Claude وحاول الربط مرة ثانية.',
            ),
          );
        return;
      }

      const email = typeof username === 'string' ? username.trim() : '';
      const clientName = store.getClient(session.client_id)?.client_name ?? 'Claude';
      const page = (status: number, opts: Partial<Parameters<typeof renderLoginPage>[0]>) =>
        res.status(status).type('html').send(renderLoginPage({ request_id, username: email, client_name: clientName, ...opts }));

      if (step === 'code_mode' || step === 'password_mode') {
        page(200, { mode: step === 'code_mode' ? 'code' : 'password' });
        return;
      }

      if (step === 'send_code') {
        try {
          const sent = await sendStreamlineLoginCode(email);
          session.created_at = Date.now();
          page(200, sent.invitationSent
            ? { mode: 'code', info: 'أعدنا إرسال دعوة الانضمام إلى بريدك. افتح الرابط وفعّل حسابك ثم ارجع هنا.' }
            : { mode: 'code', code_sent: true, info: sent.message || 'أرسلنا رمز الدخول إلى بريدك.' });
        } catch (err) {
          page(err instanceof StreamlineAuthError ? err.status : 502, {
            mode: 'code',
            error: err instanceof StreamlineAuthError ? err.message : 'تعذّر الاتصال بـ Streamline. حاول مرة ثانية بعد قليل.',
          });
        }
        return;
      }

      const finish = (result: StreamlineLoginResult) => {
        const authCode = store.createAuthCode({
          client_id: session.client_id,
          redirect_uri: session.redirect_uri,
          code_challenge: session.code_challenge,
          code_challenge_method: session.code_challenge_method,
          vendor_token: result.token,
          scope: session.scope,
        });
        pending.delete(request_id);

        // eslint-disable-next-line no-console
        console.error(
          `[oauth/authorize:POST] 302 issued code for client=${session.client_id} user="${result.user.email}" type=${result.user.type} → ${session.redirect_uri}`,
        );

        const url = new URL(session.redirect_uri);
        url.searchParams.set('code', authCode);
        if (session.state) url.searchParams.set('state', session.state);
        res.redirect(302, url.toString());
      };

      const viaCode = step === 'verify_code';
      try {
        finish(viaCode
          ? await loginToStreamlineWithCode(email, String(code || '').trim())
          : await loginToStreamline(email, String(password || '')));
      } catch (err) {
        const errMsg =
          err instanceof StreamlineAuthError
            ? err.message
            : 'تعذّر الاتصال بـ Streamline. حاول مرة ثانية بعد قليل.';
        // eslint-disable-next-line no-console
        console.error(
          `[oauth/authorize:POST] ${err instanceof StreamlineAuthError ? err.status : 502} login failed for "${email}" — ${errMsg}`,
        );
        page(err instanceof StreamlineAuthError ? err.status : 502, viaCode
          ? { mode: 'code', code_sent: true, error: errMsg }
          : { error: errMsg });
      }
    },

    /**
     * POST /oauth/token — code → tokens, or refresh → tokens.
     *
     * Logs every reject reason to stderr (visible in the Coolify
     * container logs / `npm run start:http` console). The error
     * response body itself stays terse + spec-compliant so Claude can
     * surface it through its UI without leaking internals.
     */
    token(req: Request, res: Response): void {
      const reject = (
        status: number,
        error: string,
        description: string,
        debug?: Record<string, unknown>,
      ) => {
        // eslint-disable-next-line no-console
        console.error(
          `[oauth/token] ${status} ${error}: ${description}${
            debug ? ' | ' + JSON.stringify(debug) : ''
          }`,
        );
        res.status(status).json({ error, error_description: description });
      };

      const { grant_type } = req.body || {};
      // Log every key in the request body (redact code/verifier/secrets to
      // ~12 chars). Needed to spot the RFC 8707 `resource` parameter
      // claude.ai sends — we previously didn't read or log it, and the
      // current best theory for "post-OAuth silent failure" is that
      // claude rejects the connection when the resource binding isn't
      // acknowledged in our metadata or token issuance.
      const bodyKeys: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.body || {})) {
        const s = String(v ?? '');
        bodyKeys[k] = ['code', 'code_verifier', 'refresh_token', 'client_secret'].includes(k)
          ? s.slice(0, 12) + '…'
          : s;
      }
      // eslint-disable-next-line no-console
      console.error(
        `[oauth/token] incoming grant_type=${grant_type} content-type=${req.headers['content-type']} body=${JSON.stringify(bodyKeys)}`,
      );

      if (grant_type === 'authorization_code') {
        const { code, code_verifier, client_id, redirect_uri } = req.body || {};
        if (!code) return reject(400, 'invalid_request', 'code required');

        const record = store.consumeAuthCode(String(code));
        if (!record)
          return reject(400, 'invalid_grant', 'Code expired or already used.', {
            code_prefix: String(code).slice(0, 12),
          });

        if (record.client_id !== client_id)
          return reject(400, 'invalid_client', 'client_id mismatch.', {
            stored: record.client_id,
            received: client_id,
          });

        if (record.redirect_uri !== redirect_uri)
          return reject(400, 'invalid_grant', 'redirect_uri mismatch.', {
            stored: record.redirect_uri,
            received: redirect_uri,
          });

        // PKCE verification (RFC 7636).
        if (record.code_challenge) {
          if (!code_verifier)
            return reject(400, 'invalid_grant', 'code_verifier required.');

          const method = record.code_challenge_method || 'plain';
          const expected =
            method === 'S256'
              ? createHash('sha256')
                  .update(String(code_verifier))
                  .digest('base64')
                  .replace(/=/g, '')
                  .replace(/\+/g, '-')
                  .replace(/\//g, '_')
              : String(code_verifier);
          if (expected !== record.code_challenge)
            return reject(400, 'invalid_grant', 'PKCE verification failed.', {
              method,
              expected_prefix: expected.slice(0, 12),
              stored_prefix: record.code_challenge.slice(0, 12),
            });
        }

        const tokens = store.issueTokens({
          client_id: record.client_id,
          vendor_token: record.vendor_token,
          scope: record.scope,
        });
        // eslint-disable-next-line no-console
        console.error(
          `[oauth/token] 200 authorization_code → access_token issued for client ${record.client_id}`,
        );
        res.json({
          access_token: tokens.access_token,
          token_type: 'Bearer',
          expires_in: tokens.expires_in,
          refresh_token: tokens.refresh_token,
          scope: record.scope,
        });
        return;
      }

      if (grant_type === 'refresh_token') {
        const { refresh_token, client_id } = req.body || {};
        if (!refresh_token)
          return reject(400, 'invalid_request', 'refresh_token required');

        const record = store.consumeRefreshToken(String(refresh_token));
        if (!record) return reject(400, 'invalid_grant', 'Refresh token expired.');

        if (record.client_id !== client_id)
          return reject(400, 'invalid_client', 'client_id mismatch on refresh.', {
            stored: record.client_id,
            received: client_id,
          });

        const tokens = store.issueTokens({
          client_id: record.client_id,
          vendor_token: record.vendor_token,
          scope: record.scope,
        });
        // eslint-disable-next-line no-console
        console.error(
          `[oauth/token] 200 refresh_token → access_token rotated for client ${record.client_id}`,
        );
        res.json({
          access_token: tokens.access_token,
          token_type: 'Bearer',
          expires_in: tokens.expires_in,
          refresh_token: tokens.refresh_token,
          scope: record.scope,
        });
        return;
      }

      return reject(400, 'unsupported_grant_type', `Unsupported: ${grant_type}`);
    },
  };
}

function errorPage(msg: string): string {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>خطأ</title>
<style>body{font-family:sans-serif;background:#0F1F35;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#fff;color:#0F1F35;border-radius:16px;padding:28px;max-width:420px;text-align:center}
.card h1{margin:0 0 8px;font-size:18px}</style></head><body>
<div class="card"><h1>تعذّر إكمال الطلب</h1><p>${msg.replace(/</g, '&lt;')}</p></div></body></html>`;
}
