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

const protectedResourceHandler = (req: Request, res: Response) => {
  res.json(protectedResourceMetadata(req));
};
app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
app.get('/.well-known/oauth-protected-resource/mcp', protectedResourceHandler);
app.get('/mcp/.well-known/oauth-protected-resource', protectedResourceHandler);

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
  // RFC 9728 says clients discover the OAuth metadata via the
  // `resource_metadata` parameter on the WWW-Authenticate header.
  // We point at the path that mirrors the protected resource URL
  // (which is /mcp) so any spec-aware client lands on the right doc.
  const wwwAuth = `Bearer realm="streamline-mcp", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
  if (!match) {
    res
      .status(401)
      .header('WWW-Authenticate', wwwAuth)
      .json({ error: 'invalid_token', error_description: 'Missing Bearer token.' });
    return;
  }
  const record = store.getAccessToken(match[1]);
  if (!record) {
    res
      .status(401)
      .header('WWW-Authenticate', `${wwwAuth}, error="invalid_token"`)
      .json({ error: 'invalid_token', error_description: 'Token expired or unknown.' });
    return;
  }
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

  const base = publicBaseUrl(req);

  // Short-circuit `initialize` so we can add the singular `icon`
  // field that some claude.ai clients have been observed reading,
  // alongside the SEP-973 `icons[]` array. The SDK's Zod schema
  // strips unknown fields like `icon`, so the only way to ship it
  // is to write the response ourselves.
  //
  // Rules of engagement (learned the hard way last time):
  //   1. Match the SDK's response shape EXACTLY — same fields, same
  //      types, same order. Add only ONE thing on top: `icon`.
  //   2. Keep the response small (<1KB). 32KB base64 payloads broke
  //      claude.ai's auth handshake.
  //   3. NO non-standard kitchen-sink fields (iconUrl, logoUrl,
  //      _meta, displayName, …). They get the response rejected.
  //   4. `sizes` is an ARRAY of strings per the Icon schema. A
  //      single string ("512x512") triggers Zod validation errors.
  const body = req.body as any;
  if (body?.method === 'initialize' && typeof body?.id !== 'undefined') {
    const protocolVersion = body?.params?.protocolVersion || '2025-11-25';
    const logoUrl = `${base}/logo.png`;
    res.status(200).json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'streamline-mcp',
          version: '0.4.0',
          title: 'Streamline Vendor',
          description:
            'Manage your Streamline vendor account: bookings, services, employees, reports.',
          websiteUrl: 'https://streamline.com.sa',
          // Singular `icon` field — the workaround people on
          // github.com/anthropics/claude-ai-mcp#152 keep reporting
          // "sometimes" makes the icon show in claude.ai's connector
          // list. We removed the SEP-973 `icons[]` array on user
          // request to test whether the singular form alone works.
          icon: logoUrl,
        },
      },
    });
    return;
  }

  // Build a fresh Server + tool set scoped to this vendor.
  const api = new VendorClient({ token: vendor_token });
  const tools = buildTools(api);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  // initialize is short-circuited above; this Server only handles
  // tools/list and tools/call. Keep its Implementation minimal so
  // the SDK doesn't accidentally emit competing branding fields.
  const server = new Server(
    {
      name: 'streamline-mcp',
      version: '0.4.0',
      title: 'Streamline Vendor',
      description:
        'Manage your Streamline vendor account: bookings, services, employees, reports.',
      websiteUrl: 'https://streamline.com.sa',
    },
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

// ── Periodic OAuth-store cleanup ────────────────────────────────

setInterval(() => store.cleanup(), 60 * 60 * 1000).unref();

// ── Start ────────────────────────────────────────────────────────

app.listen(PORT, HOST, () => {
  console.error(`[streamline-mcp] HTTP listening on http://${HOST}:${PORT}`);
  console.error(
    `[streamline-mcp] Public URL: ${process.env.MCP_PUBLIC_URL || '(auto-detected from request headers)'}`,
  );
});
