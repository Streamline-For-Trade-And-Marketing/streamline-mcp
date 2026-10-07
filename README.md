# streamline-mcp

MCP server that lets Claude (Desktop, Code, or claude.ai) **read and edit Streamline vendor accounts** through the same `/vendor/v1` API the mobile app uses.

Two flavours ship from one repo:

| Mode | Transport | Auth | Tenancy | Use case |
|---|---|---|---|---|
| **stdio** (`dist/index.js`) | stdin/stdout | env token | single-vendor | Claude Desktop / Code, your own account |
| **HTTP** (`dist/http-server.js`) | Streamable HTTP | OAuth 2.1 + PKCE | multi-vendor | claude.ai custom connector, any vendor |

## Tool surface (32 tools, action-based)

- **Context:** `get_profile`, `get_current_time`, `get_wallet`, `get_reports`, `get_calendar`, `preview_booking`, `list_permissions`
- **Bookings:** `booking` (list/get/create incl. per-service staff and products-only counter sales, cancel/complete/no-show status-only, approve/reject home requests, item_status, reschedule keeping each service's specialist, notes, set_customer, payment), `payment_link` (QR / pay-by-link)
- **Catalogue:** `section`, `service`, `offer`, `product`, `bundle`, `promo_code`
- **Team & access:** `employee` (invitations, busy windows), `employee_portfolio`, `role`
- **Customers:** `customer`, `review`, `cancellation_reason`
- **Business:** `branch`, `settings`, `business_profile`, `reminder`, `reminder_channels`, `google_calendar`, `invoice`, `online_payment`, `subscription`, `zatca`, `account`

Deletes and refunds are intentionally not exposed. See `src/tools.ts` for each action's fields.

---

## Local quickstart (stdio mode for Claude Desktop)

```bash
npm install
npm run build
# Add to your Claude Desktop DXT or claude.json — see /Library/Application Support/Claude/...
```

See the project's DXT extension at `~/Library/Application Support/Claude/Claude Extensions/local.streamline.streamline-vendor/` for the installed copy.

---

## Public HTTP quickstart with ngrok (Sprint 1 — full OAuth flow)

This exposes the MCP on a public HTTPS URL so you can add it as a **custom connector** in claude.ai. The full OAuth login flow is included — vendors log in with their Streamline email + password right on a branded page.

### 1. Install ngrok

```bash
brew install ngrok
ngrok config add-authtoken YOUR_NGROK_TOKEN   # free signup at ngrok.com
```

### 2. Build + start the HTTP server

```bash
npm install
npm run build
npm run start:http
# → [streamline-mcp] HTTP listening on http://0.0.0.0:3000
```

### 3. Expose it via ngrok (in a second terminal)

```bash
ngrok http 3000
# → Forwarding  https://abc-123-xyz.ngrok-free.app -> http://localhost:3000
```

Copy the `https://...ngrok-free.app` URL.

### 4. Tell the MCP its public URL

In the terminal where you started the server, set the env var and restart:

```bash
MCP_PUBLIC_URL=https://abc-123-xyz.ngrok-free.app npm run start:http
```

(Without `MCP_PUBLIC_URL`, the metadata endpoints auto-detect from the request's `Host` header — usually fine but explicit is safer.)

### 5. Add it to claude.ai

1. Go to claude.ai → **Settings** → **Connectors** → **Add custom connector**.
2. Enter the public URL: `https://abc-123-xyz.ngrok-free.app`
3. Claude auto-discovers the OAuth endpoints (`/.well-known/oauth-authorization-server`).
4. Claude registers itself via Dynamic Client Registration (`POST /oauth/register`).
5. Click **Connect** → browser opens the Streamline-branded login page.
6. Enter your Streamline email + password (or an emailed code) → the MCP validates against the Streamline API and redirects back to Claude with an auth code.
7. Claude exchanges the code for an access token. **You're done.** 32 tools are live.

Accounts without a password (Google/Apple sign-ups, invited staff) use **«الدخول برمز على البريد»** on the same page: a 6-digit code is emailed by `/vendor/v1/login/send-code`.

### 6. Try it

In claude.ai, say:

- "كم دخلي اليوم؟"
- "اعرض حجوزات اليوم في حلاق النخيل"
- "احجز ساعة 9 مساءً عند سمير خدمة حلاقة"

---

## Production deploy on Coolify

Once DNS is ready (see Cloudflare instructions):

1. Push this repo to GitHub.
2. Coolify → new Application → pick Dockerfile build pack.
3. Domain: `mcp.streamline.com.sa` — Coolify handles Let's Encrypt.
4. Persistent volume: mount `/app/data` so SQLite survives restarts.
5. Env vars:
   - `MCP_PUBLIC_URL=https://mcp.streamline.com.sa`
   - `STREAMLINE_API_BASE=https://api.streamline.com.sa` (default; the tools use the same host)
   - `STREAMLINE_WEB_URL=https://streamline.com.sa` (links for sign-up / forgot password)
   - Optional quick sign-in, same ids as the website's partner login: `GOOGLE_CLIENT_ID` (web OAuth client), `APPLE_CLIENT_ID` (Services ID), `APPLE_REDIRECT_URI` (defaults to `<origin>/oauth/authorize`). Each button shows only when its id is set. Before enabling: add `https://mcp.streamline.com.sa` to the Google client's authorized JavaScript origins, and the domain + return URL to the Apple Services ID.
6. Deploy. Health check `GET /health` should turn green.

---

## OAuth flow (technical summary)

```
1. Claude → POST /oauth/register                  (Dynamic Client Registration)
2. Claude → opens browser to /oauth/authorize?... (PKCE challenge)
3. MCP   → renders /views: Arabic login form
4. User  → submits email + password
5. MCP   → POST api.streamline.com.sa/api/v1/login  (validates upstream)
6. MCP   → stores vendor token, mints auth code, 302 to claude with code
7. Claude → POST /oauth/token  (code + verifier → access_token + refresh_token)
8. Claude → /mcp with Authorization: Bearer at_xxx  (every tool call)
9. MCP   → looks up vendor token, runs tool via VendorClient(token)
```

Token lifetimes:
- Authorization code: 5 minutes, single-use
- Access token: 1 hour
- Refresh token: 30 days, rotated on every use

The Streamline vendor JWT never leaves the MCP server. Only opaque `at_*` / `rt_*` tokens go to Claude.

---

## Project layout

```
src/
├── index.ts                  stdio entry (Claude Desktop)
├── http-server.ts            HTTP entry (Express + OAuth + MCP)
├── tools.ts                  32 tool definitions
├── vendor-client.ts          Axios wrapper + rate limiter + ZATCA cache
├── zod-to-jsonschema.ts      Minimal Zod → JSON Schema converter
├── time.ts                   Saudi-timezone helpers (Asia/Riyadh)
└── oauth/
    ├── store.ts              SQLite store (clients, codes, tokens)
    ├── handlers.ts           authorize / token / register
    ├── metadata.ts           .well-known/* documents
    ├── login-page.ts         Arabic RTL login page (inline HTML)
    └── streamline-auth.ts    /api/v1/login wrapper
Dockerfile                    Two-stage build, non-root, healthcheck
```

## Phase roadmap

- **Phase 1 ✓** — 15 read+write tools, stdio transport, single-vendor via DXT.
- **Phase 2 ✓** — 32 tools incl. creates, Saudi-timezone aware, walk-in support, completed-immutable guard, VAT auto-stripped.
- **Phase 3 ✓** — HTTP+SSE transport, OAuth 2.1 with login page, Dockerfile, ready for Coolify.
- **Phase 4** — refresh token rotation hardening, per-vendor rate limiting, audit logging, admin endpoints.
