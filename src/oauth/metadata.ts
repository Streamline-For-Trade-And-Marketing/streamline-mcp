/**
 * OAuth 2.1 discovery documents.
 *
 * Two well-known endpoints are required for Claude (or any compliant
 * MCP client) to bootstrap the auth flow without hard-coded URLs:
 *
 *   1. /.well-known/oauth-protected-resource
 *      Tells the client "this resource (the MCP endpoint) is protected
 *      and here is the authorization server you should talk to." Per
 *      RFC 9728 (OAuth 2.0 Protected Resource Metadata).
 *
 *   2. /.well-known/oauth-authorization-server
 *      Tells the client where the actual authorize / token / register
 *      endpoints live, what grant types we support, etc. Per RFC 8414
 *      (OAuth 2.0 Authorization Server Metadata).
 *
 * Both documents are absolute URLs so we need to know the public base
 * URL the MCP is reachable on. We accept a `MCP_PUBLIC_URL` env var
 * (e.g. `https://abc-123.ngrok-free.app` during testing, or
 * `https://mcp.streamline.com.sa` in production). Falling back to the
 * request's `Host` header so ngrok still works without configuration.
 */
import type { Request } from 'express';

export function publicBaseUrl(req?: Request): string {
  if (process.env.MCP_PUBLIC_URL) {
    return process.env.MCP_PUBLIC_URL.replace(/\/+$/, '');
  }
  if (req) {
    // Honour the forwarded headers ngrok / Coolify set so we generate
    // https URLs even though Express sees http internally.
    const proto =
      (req.headers['x-forwarded-proto'] as string)?.split(',')[0].trim() ||
      req.protocol ||
      'https';
    const host =
      (req.headers['x-forwarded-host'] as string) ||
      req.headers.host ||
      'localhost:3000';
    return `${proto}://${host}`;
  }
  return 'http://localhost:3000';
}

/**
 * Branding fields surfaced in BOTH metadata documents so a connector
 * UI (Claude.ai's "Connectors" list, for example) can render the
 * server's logo + display name + description.
 *
 * No single standard owns the icon — RFC 7591 has `logo_uri` for
 * CLIENTS, no comparable field for AS/protected-resource. We cast a
 * wide net by mirroring every field shape any real MCP client has
 * been observed to consult:
 *   • `logo_uri`   — OIDC + RFC 7591 client metadata convention
 *   • `logo_url`   — snake_case variant some implementations use
 *   • `icon`       — short alias
 *   • `icon_url` / `iconUrl` — observed in some MCP server schemas
 *   • `name` + `display_name` + `title` — display label
 *
 * If Claude.ai never reads any of these (which we suspect for Custom
 * Connectors — they show a generic globe icon by design), no harm
 * done. If it (or any other MCP client) starts honouring one, we're
 * already set without a redeploy.
 */
function branding(base: string): Record<string, unknown> {
  const logo = `${base}/logo.png`;
  return {
    name: 'Streamline Vendor',
    display_name: 'Streamline Vendor',
    title: 'Streamline Vendor',
    description: 'Manage Streamline bookings, services, employees and reports.',
    logo_uri: logo,
    logo_url: logo,
    icon: logo,
    icon_url: logo,
    iconUrl: logo,
    client_uri: 'https://streamline.com.sa',
    homepage_uri: 'https://streamline.com.sa',
    contacts: ['support@streamline.com.sa'],
  };
}

export function protectedResourceMetadata(req: Request): Record<string, unknown> {
  const base = publicBaseUrl(req);
  // RFC 8707 + WHATWG URL canonicalization: a host-only URL like
  // `https://mcp.streamline.com.sa` normalizes to
  // `https://mcp.streamline.com.sa/` (implicit root path = "/").
  //
  // The live logs confirm claude.ai ALWAYS sends the trailing-slash
  // form on /oauth/authorize and /oauth/token:
  //
  //   resource=https://mcp.streamline.com.sa/
  //
  // …because claude.ai runs the user-typed URL through the browser's
  // URL parser to canonicalize before signing the resource parameter.
  // RFC 8707 §2: the resource parameter MUST be passed byte-for-byte
  // to the audience check.
  //
  // We previously declared `resource: <base>` (no slash) — those two
  // values then disagreed for resource-validation purposes, and
  // claude.ai's connector quietly drops the connection rather than
  // emitting a token-bound to the wrong audience. That was the
  // post-OAuth silent-failure symptom we've been chasing.
  //
  // FIX: declare the resource with the same trailing slash claude.ai
  // sends. The authorization_servers entry stays slash-less because
  // that's the OAuth 2.0 issuer convention.
  const resource = `${base}/`;
  return {
    resource,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    resource_documentation: `${base}/`,
    ...branding(base),
  };
}

export function authorizationServerMetadata(req: Request): Record<string, unknown> {
  const base = publicBaseUrl(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    // PKCE is mandatory for public clients in OAuth 2.1.
    code_challenge_methods_supported: ['S256', 'plain'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    response_types_supported: ['code'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['vendor'],
    ...branding(base),
  };
}
