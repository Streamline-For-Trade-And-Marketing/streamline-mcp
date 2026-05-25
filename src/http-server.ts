#!/usr/bin/env node
/**
 * HTTP entry point for the Streamline MCP server.
 *
 * Stack:
 *   • Express  — routing + JSON / form body parsing
 *   • Streamable-HTTP MCP transport (stateless mode) — every /mcp
 *     request spins up a fresh Server + transport, handles the
 *     JSON-RPC payload, tears down. Avoids long-lived session state
 *     in this POC.
 *   • OAuth 2.1 with Dynamic Client Registration + PKCE — see
 *     `oauth/handlers.ts` for the actual flow.
 *
 * Routes:
 *   GET  /                                       human-readable landing
 *   GET  /health                                 liveness probe (Coolify health check)
 *   GET  /.well-known/oauth-protected-resource   RFC 9728
 *   GET  /.well-known/oauth-authorization-server RFC 8414
 *   POST /oauth/register                         Dynamic Client Registration (RFC 7591)
 *   GET  /oauth/authorize                        renders the Streamline login page
 *   POST /oauth/authorize                        handles the login form
 *   POST /oauth/token                            code → tokens, refresh → tokens
 *   *    /mcp                                    MCP Streamable HTTP transport
 *
 * Local run:
 *   npm run build && npm run start:http
 *   ngrok http 3000
 *   # paste the ngrok https URL into claude.ai → Connectors
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { OauthStore } from './oauth/store.js';
import { makeOauthHandlers } from './oauth/handlers.js';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  publicBaseUrl,
} from './oauth/metadata.js';
import { VendorClient } from './vendor-client.js';
import { buildTools } from './tools.js';
import { zodToJsonSchema } from './zod-to-jsonschema.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
// Trust the first hop (ngrok / Coolify Traefik) so req.protocol +
// X-Forwarded-* headers reflect the public URL, which the metadata
// endpoints use to build absolute URLs.
app.set('trust proxy', 1);
app.use(express.json({ limit: '4mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Request log middleware ──────────────────────────────────────
//
// Logs every single HTTP request the moment it arrives, BEFORE any
// other middleware can short-circuit it. Specifically aimed at
// debugging claude.ai connector failures where we previously couldn't
// tell whether a request even reached the server (auth failures inside
// /mcp don't log on the success-only [mcp] path, and Cloudflare 4xx's
// before the request would invisibly drop too). Every line is prefixed
// with [req] so it's grep-able in the Coolify logs panel.
app.use((req, _res, next) => {
  const auth = req.headers.authorization
    ? `auth=${(req.headers.authorization as string).slice(0, 14)}…`
    : 'auth=(none)';
  // eslint-disable-next-line no-console
  console.error(
    `[req] ${req.method} ${req.path} ua="${(req.headers['user-agent'] || '').slice(0, 60)}" ${auth} ct=${req.headers['content-type'] || '-'} accept=${req.headers.accept || '-'}`,
  );
  next();
});

// Static assets — logo + favicon. Cached aggressively (immutable
// for a year) since the filename never changes inside a deploy and
// a redeploy bumps the docker image hash anyway. Mounted BEFORE the
// landing-or-mcp branch on / so /logo.png hits this short-circuit
// even when the request carries an Authorization header.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, '..', 'public');
app.use(
  express.static(PUBLIC_DIR, {
    maxAge: '365d',
    immutable: true,
  }),
);
// /favicon.ico is now a real multi-resolution ICO file served by
// express.static above. The alias route is no longer needed.

// (Was loading the logo as a base64 data URI to embed in the
// initialize response — claude.ai rejected the 32KB payload with a
// JSON-Schema validation error. The icons array now uses the hosted
// URL instead, see the initialize handler below.)

const store = new OauthStore();
const oauth = makeOauthHandlers(store);

// ── Landing + liveness ───────────────────────────────────────────
//
// GET / serves a human landing page when a browser visits — but the
// SAME path is the MCP endpoint when an authenticated client hits it.
// Claude.ai treats the connector URL itself as the MCP endpoint (no
// `/mcp` suffix), so we MUST serve MCP at the root or every tool
// call comes back 404. We branch on the Authorization header: present
// → fall through to the MCP handler chain below; absent → static HTML.

const landingHtml = (req: Request) => {
  const base = publicBaseUrl(req);
  return `<!doctype html><html lang="ar" dir="rtl">
<head><meta charset="utf-8"><title>Streamline MCP</title>
<!-- Icon discovery — multi-resolution favicons + ICO + Apple
     touch icon + Web App Manifest. Anthropic has said in passing
     they "use the Google provided favicon" service to pick the
     connector icon, and that service consumes whatever the domain
     exposes via the standard link conventions. Providing a real
     multi-resolution favicon.ico at the root + sized PNG variants
     gives Google's crawler the cleanest signal. -->
<link rel="icon" type="image/x-icon" href="/favicon.ico" />
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
<link rel="icon" type="image/png" sizes="64x64" href="/favicon-64.png" />
<link rel="icon" type="image/png" sizes="128x128" href="/favicon-128.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
<link rel="manifest" href="/manifest.json" />
<!-- OpenGraph + Twitter card so any UI that previews this URL
     (Claude's connector preview, Slack unfurls, etc.) picks up the
     real branding instead of a default placeholder. -->
<meta property="og:type" content="website" />
<meta property="og:title" content="Streamline Vendor MCP" />
<meta property="og:description" content="Connect Claude to a Streamline vendor account." />
<meta property="og:image" content="${base}/logo.png" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="512" />
<meta property="og:image:height" content="512" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:image" content="${base}/logo.png" />
<style>body{font-family:-apple-system,sans-serif;background:#0F1F35;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{background:#fff;color:#0F1F35;border-radius:20px;padding:32px;max-width:480px;line-height:1.6;text-align:center}
.brand-mark{width:80px;height:80px;border-radius:20px;background:#0F1F35;display:inline-flex;align-items:center;justify-content:center;padding:12px;box-shadow:0 8px 20px rgba(15,31,53,0.3);margin-bottom:16px}
.brand-mark img{width:100%;height:100%;object-fit:contain;display:block}
h1{margin:0 0 8px}code{background:#F1F5F9;padding:2px 6px;border-radius:4px;font-size:13px;direction:ltr;display:inline-block}</style>
</head><body><div class="card">
<div class="brand-mark"><img src="/logo.png" alt="Streamline" /></div>
<h1>Streamline MCP</h1>
<p>هذا الـ endpoint لربط حساب Streamline مع Claude. لازم تضيفه كـ <strong>custom connector</strong> داخل Claude.ai:</p>
<p><code>${base}</code></p>
<p style="font-size:13px;color:#64748B">المنشأة المسؤولة: Streamline. الـ MCP لا يخزن كلمات المرور — يبدّلها مع API Streamline ويرجّع توكن خاص بـ Claude.</p>
</div></body></html>`;
};

app.get('/', (req, res, next) => {
  if (req.headers.authorization) return next(); // → bearerAuth → mcpHandler
  res.type('html').send(landingHtml(req));
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'streamline-mcp', version: '0.4.0' });
});

// ── OAuth discovery + endpoints ─────────────────────────────────
//
// Per RFC 9728, when the resource URL has a path component, the
// well-known metadata URL is built by appending the well-known suffix
// to the FULL resource URL. So for resource `https://x/mcp`, the
// metadata lives at `https://x/.well-known/oauth-protected-resource/mcp`
// AND many clients also probe `https://x/mcp/.well-known/...`. We
// serve both shapes so Claude (and any other MCP client) can discover
// us no matter which path they try first.

// Each metadata URL path corresponds to a different resource URL,
// per RFC 9728 §3.1. The path suffix on the well-known URL maps
// directly to the path component of the protected resource URL.
// So GET /.well-known/oauth-protected-resource/sse must declare
// `resource: <base>/sse`, /mcp the /mcp form, and the unsuffixed
// path the bare-base form.
const protectedResourceHandler = (resourcePath: string) => (req: Request, res: Response) => {
  res.json(protectedResourceMetadata(req, resourcePath));
};
app.get('/.well-known/oauth-protected-resource', protectedResourceHandler('/'));
app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceHandler('/mcp'));
app.get('/.well-known/oauth-protected-resource/sse', protectedResourceHandler('/sse'));
app.get('/mcp/.well-known/oauth-protected-resource', protectedResourceHandler('/mcp'));
app.get('/sse/.well-known/oauth-protected-resource', protectedResourceHandler('/sse'));

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json(authorizationServerMetadata(req));
});

app.post('/oauth/register', (req, res) => oauth.register(req, res));
app.get('/oauth/authorize', (req, res) => oauth.authorizeGet(req, res));
app.post('/oauth/authorize', (req, res) => oauth.authorizePost(req, res));
app.post('/oauth/token', (req, res) => oauth.token(req, res));

// ── Bearer-token auth middleware (only protects /mcp) ───────────

function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const base = publicBaseUrl(req);
  // RFC 9728 + Anthropic's connector spec require that the
  // `resource_metadata` URL path mirrors the protected resource URL's
  // path component, AND the `resource` field inside the metadata MUST
  // match what the user types into Claude as the connector URL.
  //
  // The MCP endpoint can be reached at THREE paths in this server:
  //   /        — Streamable HTTP transport at the root
  //   /mcp     — Streamable HTTP transport (same handler)
  //   /sse     — legacy SSE transport (workaround for claude.ai bug)
  //
  // For each one, the metadata URL path MUST mirror the path of the
  // resource being protected, otherwise claude.ai bails silently
  // after OAuth completes — that's the long-standing post-OAuth
  // failure pattern documented in anthropics/claude-ai-mcp#291 et al.
  //
  // See: https://claude.com/docs/connectors/building/authentication
  // > Always return a 401 with a WWW-Authenticate header whose
  // > resource_metadata parameter points at your protected resource
  // > metadata document. […] The protected resource metadata
  // > document's `resource` field must match your MCP server URL
  // > exactly as the user enters it in Claude, including any path
  // > component.
  let suffix = '';
  if (req.path === '/sse' || req.path.startsWith('/sse/')) suffix = '/sse';
  else if (req.path === '/mcp' || req.path.startsWith('/mcp/')) suffix = '/mcp';
  // WWW-Authenticate header form MATCHED to Higgsfield's known-working
  // claude.ai connector. Specifically:
  //   • drop the `realm=` parameter — claude.ai parses Bearer challenges
  //     and the realm token apparently confuses its tokenizer
  //   • include `scope=` so claude.ai sees the SAME scope list
  //     declared in the protected-resource metadata body, in the
  //     space-separated form RFC 6750 §3 wants on the header
  const wwwAuth = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${suffix}", scope="openid email offline_access"`;
  if (!match) {
    // eslint-disable-next-line no-console
    console.error(
      `[bearerAuth] 401 missing bearer on ${req.method} ${req.path} (raw header="${header.slice(0, 30)}")`,
    );
    res
      .status(401)
      .header('WWW-Authenticate', wwwAuth)
      .json({ error: 'invalid_token', error_description: 'Missing Bearer token.' });
    return;
  }
  const tokenPrefix = match[1].slice(0, 16);
  const record = store.getAccessToken(match[1]);
  if (!record) {
    // eslint-disable-next-line no-console
    console.error(
      `[bearerAuth] 401 unknown/expired token "${tokenPrefix}…" on ${req.method} ${req.path}`,
    );
    res
      .status(401)
      .header('WWW-Authenticate', `${wwwAuth}, error="invalid_token"`)
      .json({ error: 'invalid_token', error_description: 'Token expired or unknown.' });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(
    `[bearerAuth] 200 token "${tokenPrefix}…" ok (client=${record.client_id}) on ${req.method} ${req.path}`,
  );
  // Attach the vendor token onto the request so the MCP handlers below
  // can construct a per-request VendorClient.
  (req as any).vendor_token = record.vendor_token;
  next();
}

// ── MCP endpoint ────────────────────────────────────────────────
//
// We run the SDK transport in STATELESS mode (no session id) — every
// HTTP request is a single self-contained MCP JSON-RPC interaction.
// That keeps the multi-vendor story simple: nothing leaks between
// requests, and we can scale horizontally without sticky sessions.

// ── MCP request handler (reused at both / and /mcp) ─────────────

async function mcpHandler(req: Request, res: Response): Promise<void> {
  const vendor_token = (req as any).vendor_token as string;
  if (!vendor_token) {
    res.status(401).json({ error: 'invalid_token' });
    return;
  }

  // eslint-disable-next-line no-console
  console.error(
    `[mcp] ${req.method} ${req.path} method=${(req.body as any)?.method ?? '(none)'}`,
  );

  // Build a fresh Server + tool set scoped to this vendor.
  //
  // RESPONSE SHAPE — DELIBERATELY MINIMAL.
  //
  // The MCP `Implementation` schema in @modelcontextprotocol/sdk@1.29.0
  // allows {name, title?, version, icons?, websiteUrl?, description?}.
  // Anything beyond name+version is OPTIONAL, and we now believe one
  // of those optional fields is what claude.ai's connector setup
  // chokes on during the "validate first /mcp response" step that
  // happens right after the OAuth token is issued — the symptom is
  // that the OAuth dance completes cleanly (the live logs prove it),
  // but Claude never makes the follow-up /mcp call and reports
  // `Authorization with the MCP server failed`.
  //
  // History of attempts on this:
  //   1. `icon: <url>` (singular, not in spec) — failed.
  //   2. `icons: [{src,mimeType,sizes}]` (spec form) — still failed.
  //   3. Drop ALL optional branding fields ← we are HERE.
  //
  // Claude.ai surfaces the connector's icon by hitting `/logo.png`
  // and the standard favicon paths directly (Google favicon service)
  // — so we don't need to declare it in `serverInfo` at all to get
  // a logo in the UI. The static handler at the top of this file
  // serves `/logo.png` + the multi-resolution favicons; that's the
  // discovery path Claude actually uses.
  //
  // We also DROP the manual initialize short-circuit and let the
  // SDK build the response in its own (always-valid) format. Less
  // surface area for a typo to invalidate the handshake.
  const api = new VendorClient({ token: vendor_token });
  const tools = buildTools(api);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: 'streamline-mcp', version: '0.4.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolsByName.get(name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `Invalid arguments for ${name}: ${parsed.error.message}` },
        ],
      };
    }
    try {
      const result = await tool.handler(parsed.data);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error calling ${name}: ${err?.message ?? err}` }],
      };
    }
  });

  // Stateless transport. Setting `sessionIdGenerator: undefined`
  // tells the SDK each HTTP request is fully self-contained — no
  // session tracking, no Mcp-Session-Id header. This is the right
  // mode for multi-tenant deployments where every call carries its
  // own auth and we don't want to keep server-side state per
  // vendor connection.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(`[mcp] handler error: ${err?.message ?? err}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error', error_description: String(err) });
    }
  }

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
}

// Mount at BOTH the root and /mcp so the connector works whether
// the vendor entered https://host or https://host/mcp in Claude.ai.
// Claude.ai treats the configured URL as the MCP endpoint directly —
// it does NOT append /mcp based on the protected-resource metadata.
app.post('/', bearerAuth, mcpHandler);
app.get('/', bearerAuth, mcpHandler);
app.delete('/', bearerAuth, mcpHandler);

app.post('/mcp', bearerAuth, mcpHandler);
app.get('/mcp', bearerAuth, mcpHandler);
app.delete('/mcp', bearerAuth, mcpHandler);

// ── /sse legacy transport (claude.ai connector workaround) ──────
//
// claude.ai's custom-connector implementation has a long-standing,
// "Closed: not planned" bug that breaks the post-OAuth handshake on
// /mcp (Streamable HTTP) endpoints — the OAuth dance completes
// cleanly (logs prove it), but Claude.ai then silently fails to send
// the follow-up POST initialize, and the user gets
//   "Authorization with the MCP server failed (ofid_…)"
// every time.
//
// The documented workaround is to expose the LEGACY SSE transport
// (separate code path inside claude.ai's connector that doesn't share
// the broken validation step) at /sse. See:
//   • https://github.com/anthropics/claude-ai-mcp/issues/291
//   • https://github.com/anthropics/claude-ai-mcp/issues/155
//
// The SSE transport is stateful: the GET /sse request opens a
// long-lived event-stream, the server pushes JSON-RPC responses down
// it, and the client sends incoming messages via POST /messages?
// sessionId=<id>. We keep a session map keyed by sessionId →
// {transport, vendor_token}. Sessions are torn down on close.
//
// The bearer-token check still runs on BOTH endpoints — Claude must
// be authenticated to either open the SSE stream OR post a message.

interface SseSession {
  transport: SSEServerTransport;
  vendor_token: string;
}
const sseSessions = new Map<string, SseSession>();

app.get('/sse', bearerAuth, async (req: Request, res: Response) => {
  const vendor_token = (req as any).vendor_token as string;
  // eslint-disable-next-line no-console
  console.error(`[sse] GET /sse opening stream (vendor_token len=${vendor_token.length})`);

  // The endpoint path claude.ai posts back to. Must be served by us.
  const transport = new SSEServerTransport('/messages', res);
  const sessionId = transport.sessionId;
  sseSessions.set(sessionId, { transport, vendor_token });

  // eslint-disable-next-line no-console
  console.error(`[sse] sessionId=${sessionId} (active sessions=${sseSessions.size})`);

  // Spin up a fresh per-vendor Server + tool set, connected via the
  // SSE transport. Same wiring as the /mcp path; only the transport
  // differs.
  const api = new VendorClient({ token: vendor_token });
  const tools = buildTools(api);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: 'streamline-mcp', version: '0.4.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolsByName.get(name);
    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    const parsed = tool.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `Invalid arguments for ${name}: ${parsed.error.message}` },
        ],
      };
    }
    try {
      const result = await tool.handler(parsed.data);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error calling ${name}: ${err?.message ?? err}` }],
      };
    }
  });

  // Clean up when the client disconnects (browser navigates away,
  // network drops, or claude.ai tears the connection). Without this
  // we'd accumulate dead sessions in memory.
  res.on('close', () => {
    // eslint-disable-next-line no-console
    console.error(`[sse] sessionId=${sessionId} closed (active sessions=${sseSessions.size - 1})`);
    sseSessions.delete(sessionId);
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(`[sse] connect error: ${err?.message ?? err}`);
    sseSessions.delete(sessionId);
    if (!res.headersSent) res.status(500).end();
  }
});

// POST /messages?sessionId=<id> — the client's outbound channel in
// the SSE transport. NO bearerAuth on this one because the sessionId
// itself is the authorization (it's an opaque UUID we minted and
// handed to the authenticated client over the SSE stream). Anyone
// without the sessionId can't post messages.
app.post('/messages', async (req: Request, res: Response) => {
  const sessionId = (req.query.sessionId as string) || '';
  const session = sseSessions.get(sessionId);
  if (!session) {
    // eslint-disable-next-line no-console
    console.error(`[sse] POST /messages 404 unknown sessionId="${sessionId}"`);
    res.status(404).json({ error: 'unknown_session' });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(
    `[sse] POST /messages sessionId=${sessionId} method=${(req.body as any)?.method ?? '(none)'}`,
  );
  try {
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(`[sse] handlePostMessage error: ${err?.message ?? err}`);
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
});

// ── Periodic OAuth-store cleanup ────────────────────────────────

setInterval(() => store.cleanup(), 60 * 60 * 1000).unref();

// ── Start ────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.error(`[streamline-mcp] HTTP listening on http://${HOST}:${PORT}`);
  console.error(
    `[streamline-mcp] Public URL: ${process.env.MCP_PUBLIC_URL || '(auto-detected from request headers)'}`,
  );
});
