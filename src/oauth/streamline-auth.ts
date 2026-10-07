/**
 * Bridge from Streamline credentials → vendor bearer token.
 *
 * The mobile app's `authApi.login()` (see mobile/src/api/endpoints/auth.ts)
 * hits `POST /api/v1/login` with multipart `username` + `password`. The
 * response includes an `access_token` on the user object — that's the
 * same bearer the rest of the /vendor/v1 surface accepts.
 *
 * We replay exactly that call from the MCP server during the OAuth
 * `/authorize` flow: the vendor types their Streamline email + password
 * into our login page, we forward them to /api/v1/login, and if it
 * succeeds we store the returned token in the OAuth store and return
 * an opaque MCP access_token to Claude.
 *
 * Important: we NEVER show the underlying Streamline token to Claude.
 * Only the MCP-scoped opaque tokens leave this process.
 */
import axios from 'axios';

const DEFAULT_API_BASE =
  process.env.STREAMLINE_API_BASE || 'https://api.streamline.com.sa';

export interface StreamlineLoginResult {
  token: string;
  user: {
    id: number;
    name: string;
    email: string;
    type: string;
  };
}

export class StreamlineAuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

/**
 * Exchange Streamline credentials for the vendor bearer token.
 *
 * Throws StreamlineAuthError on bad creds (401) or non-vendor user types
 * (403 — customer accounts can't use the vendor MCP). All other errors
 * (network, 5xx) bubble as a generic Error so the caller can render a
 * "try again" message without leaking internals.
 */
export async function loginToStreamline(
  username: string,
  password: string,
): Promise<StreamlineLoginResult> {
  if (!username || !password) {
    throw new StreamlineAuthError('Username and password are required.', 400);
  }
  const fd = new FormData();
  fd.append('username', username);
  fd.append('password', password);
  return sessionFrom(await postToStreamline('/api/v1/login', fd), 'Invalid email or password.');
}

/** Emails a one-time sign-in code; invited staff get their invitation again instead. */
export async function sendStreamlineLoginCode(
  email: string,
): Promise<{ invitationSent: boolean; message: string }> {
  if (!email) throw new StreamlineAuthError('البريد الإلكتروني مطلوب.', 400);
  const fd = new FormData();
  fd.append('email', email.trim().toLowerCase());
  const res = await postToStreamline('/vendor/v1/login/send-code', fd);
  if (res.status !== 200 || !res.data?.success) {
    throw new StreamlineAuthError(res.data?.message || 'تعذّر إرسال الرمز.', res.status || 400);
  }
  return { invitationSent: Boolean(res.data?.data?.invitation_sent), message: res.data?.message || '' };
}

export async function loginToStreamlineWithCode(
  email: string,
  code: string,
): Promise<StreamlineLoginResult> {
  if (!email || !/^\d{6}$/.test(code)) {
    throw new StreamlineAuthError('أدخل الرمز المكوّن من ٦ أرقام.', 400);
  }
  const fd = new FormData();
  fd.append('email', email.trim().toLowerCase());
  fd.append('code', code);
  return sessionFrom(await postToStreamline('/vendor/v1/login/code', fd), 'الرمز غير صحيح.');
}

async function postToStreamline(path: string, fd: FormData) {
  try {
    return await axios.post(`${DEFAULT_API_BASE}${path}`, fd, {
      headers: { 'Accept-Language': 'ar', Accept: 'application/json' },
      timeout: 15_000,
      validateStatus: () => true,
    });
  } catch {
    throw new Error('Could not reach Streamline. Please try again.');
  }
}

function sessionFrom(res: { status: number; data: any }, fallback: string): StreamlineLoginResult {
  const body = res.data;
  if (res.status !== 200 || !body?.success) {
    throw new StreamlineAuthError(body?.message || fallback, res.status || 401);
  }
  const user = body.data;
  const token = user?.access_token;
  if (!token) {
    throw new StreamlineAuthError(
      'Login succeeded but no token was returned by Streamline.',
      502,
    );
  }
  if (user.type !== 'vendor' && user.type !== 'employee') {
    throw new StreamlineAuthError(
      'This account type is not supported by the vendor MCP.',
      403,
    );
  }
  return {
    token,
    user: {
      id: user.id,
      name: `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || user.email,
      email: user.email,
      type: user.type,
    },
  };
}
