/**
 * SQLite-backed store for the OAuth 2.1 layer.
 *
 * Tables:
 *   - clients               registered OAuth clients (Claude.ai gets one per
 *                           install via Dynamic Client Registration)
 *   - authorization_codes   short-lived codes returned from /authorize that
 *                           the client redeems at /token (single use, 5 min)
 *   - access_tokens         long-lived tokens the client sends in
 *                           Authorization: Bearer for every /mcp call.
 *                           Mapped to the underlying Streamline vendor
 *                           bearer token so the MCP can act on the
 *                           vendor's behalf without ever exposing the
 *                           upstream token to Claude.
 *   - refresh_tokens        Used to mint a new access_token without
 *                           forcing the vendor to log in again.
 *
 * Why SQLite: zero ops, one file under /app/data (mounted as a Coolify
 * volume in prod). No external DB to provision for a POC. Migrating to
 * Postgres later is straightforward — every method here is a single
 * SQL statement, no ORM lock-in.
 *
 * The Streamline vendor token is stored in plaintext for this first
 * deployment so we can iterate fast. Once the flow is proven, wrap
 * the read/write helpers with AES-GCM using a key from env — the
 * call sites won't change.
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_DB_PATH = process.env.MCP_DB_PATH || './data/mcp.sqlite';

// Lifetimes (seconds).
const CODE_TTL = 5 * 60;              // 5 minutes — auth codes are single-use
const ACCESS_TOKEN_TTL = 60 * 60;     // 1 hour
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days

export interface OauthClient {
  client_id: string;
  client_secret: string | null;
  client_name: string;
  redirect_uris: string[];
  created_at: number;
}

export interface AuthCodeRecord {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  vendor_token: string;
  scope: string;
  expires_at: number;
}

export interface AccessTokenRecord {
  access_token: string;
  client_id: string;
  vendor_token: string;
  scope: string;
  expires_at: number;
}

export interface RefreshTokenRecord {
  refresh_token: string;
  client_id: string;
  vendor_token: string;
  scope: string;
  expires_at: number;
}

export class OauthStore {
  private db: Database.Database;

  constructor(path = DEFAULT_DB_PATH) {
    // Ensure the data dir exists. On Coolify this is a mounted volume,
    // locally it's just a relative ./data folder.
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        client_id TEXT PRIMARY KEY,
        client_secret TEXT,
        client_name TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS authorization_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT,
        code_challenge_method TEXT,
        vendor_token TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (client_id) REFERENCES clients(client_id)
      );

      CREATE TABLE IF NOT EXISTS access_tokens (
        access_token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        vendor_token TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (client_id) REFERENCES clients(client_id)
      );

      CREATE TABLE IF NOT EXISTS refresh_tokens (
        refresh_token TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        vendor_token TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (client_id) REFERENCES clients(client_id)
      );

      CREATE INDEX IF NOT EXISTS idx_access_tokens_expires ON access_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
      CREATE INDEX IF NOT EXISTS idx_auth_codes_expires ON authorization_codes(expires_at);
    `);
  }

  // ────────────────────────────────────────────────────────────
  //  Clients (Dynamic Client Registration)
  // ────────────────────────────────────────────────────────────

  registerClient(client_name: string, redirect_uris: string[]): OauthClient {
    const client_id = `mcp_${randomBytes(16).toString('hex')}`;
    // RFC 7591 allows confidential or public clients. Claude.ai uses
    // PKCE so we leave the secret null (public client). If a confidential
    // client ever registers we can populate this.
    const client_secret = null;
    const created_at = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO clients (client_id, client_secret, client_name, redirect_uris, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(client_id, client_secret, client_name, JSON.stringify(redirect_uris), created_at);
    return { client_id, client_secret, client_name, redirect_uris, created_at };
  }

  getClient(client_id: string): OauthClient | null {
    const row = this.db
      .prepare(`SELECT * FROM clients WHERE client_id = ?`)
      .get(client_id) as any;
    if (!row) return null;
    return {
      client_id: row.client_id,
      client_secret: row.client_secret,
      client_name: row.client_name,
      redirect_uris: JSON.parse(row.redirect_uris),
      created_at: row.created_at,
    };
  }

  // ────────────────────────────────────────────────────────────
  //  Authorization codes
  // ────────────────────────────────────────────────────────────

  createAuthCode(input: {
    client_id: string;
    redirect_uri: string;
    code_challenge: string | null;
    code_challenge_method: string | null;
    vendor_token: string;
    scope: string;
  }): string {
    const code = `code_${randomBytes(24).toString('hex')}`;
    const expires_at = Math.floor(Date.now() / 1000) + CODE_TTL;
    this.db
      .prepare(
        `INSERT INTO authorization_codes
         (code, client_id, redirect_uri, code_challenge, code_challenge_method,
          vendor_token, scope, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        code,
        input.client_id,
        input.redirect_uri,
        input.code_challenge,
        input.code_challenge_method,
        input.vendor_token,
        input.scope,
        expires_at,
      );
    return code;
  }

  /** Atomically consume an auth code — single-use by design. */
  consumeAuthCode(code: string): AuthCodeRecord | null {
    const tx = this.db.transaction((code: string) => {
      const row = this.db
        .prepare(`SELECT * FROM authorization_codes WHERE code = ?`)
        .get(code) as any;
      if (!row) return null;
      // Delete regardless of expiry — single use, even if just to read.
      this.db.prepare(`DELETE FROM authorization_codes WHERE code = ?`).run(code);
      if (row.expires_at < Math.floor(Date.now() / 1000)) return null;
      return row as AuthCodeRecord;
    });
    return tx(code);
  }

  // ────────────────────────────────────────────────────────────
  //  Access + refresh tokens
  // ────────────────────────────────────────────────────────────

  issueTokens(input: {
    client_id: string;
    vendor_token: string;
    scope: string;
  }): { access_token: string; refresh_token: string; expires_in: number } {
    const access_token = `at_${randomBytes(32).toString('hex')}`;
    const refresh_token = `rt_${randomBytes(32).toString('hex')}`;
    const now = Math.floor(Date.now() / 1000);
    const access_expires = now + ACCESS_TOKEN_TTL;
    const refresh_expires = now + REFRESH_TOKEN_TTL;
    this.db
      .prepare(
        `INSERT INTO access_tokens
         (access_token, client_id, vendor_token, scope, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(access_token, input.client_id, input.vendor_token, input.scope, access_expires);
    this.db
      .prepare(
        `INSERT INTO refresh_tokens
         (refresh_token, client_id, vendor_token, scope, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(refresh_token, input.client_id, input.vendor_token, input.scope, refresh_expires);
    return { access_token, refresh_token, expires_in: ACCESS_TOKEN_TTL };
  }

  /** Look up an access token to authorise an /mcp call. */
  getAccessToken(access_token: string): AccessTokenRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM access_tokens WHERE access_token = ?`)
      .get(access_token) as any;
    if (!row) return null;
    if (row.expires_at < Math.floor(Date.now() / 1000)) {
      // Lazy cleanup of expired tokens.
      this.db.prepare(`DELETE FROM access_tokens WHERE access_token = ?`).run(access_token);
      return null;
    }
    return row as AccessTokenRecord;
  }

  /** Rotate a refresh token — old one becomes invalid, new pair returned. */
  consumeRefreshToken(refresh_token: string): RefreshTokenRecord | null {
    const tx = this.db.transaction((token: string) => {
      const row = this.db
        .prepare(`SELECT * FROM refresh_tokens WHERE refresh_token = ?`)
        .get(token) as any;
      if (!row) return null;
      this.db.prepare(`DELETE FROM refresh_tokens WHERE refresh_token = ?`).run(token);
      if (row.expires_at < Math.floor(Date.now() / 1000)) return null;
      return row as RefreshTokenRecord;
    });
    return tx(refresh_token);
  }

  /** Sweep expired rows. Cheap to run on a schedule, idempotent. */
  cleanup(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`DELETE FROM authorization_codes WHERE expires_at < ?`).run(now);
    this.db.prepare(`DELETE FROM access_tokens WHERE expires_at < ?`).run(now);
    this.db.prepare(`DELETE FROM refresh_tokens WHERE expires_at < ?`).run(now);
  }
}
