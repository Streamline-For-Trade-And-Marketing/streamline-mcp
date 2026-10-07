/**
 * The login + consent page served at /oauth/authorize.
 *
 * Single self-contained HTML document — no build step, no frameworks,
 * no external CSS files. That keeps the OAuth flow's first-paint fast
 * even on bad cellular and avoids cross-origin asset issues during
 * the redirect dance.
 *
 * Visual language matches the mobile app: navy header (#0F1F35),
 * teal accent (#5BD7C8), white surface for the card, Arabic-first
 * RTL layout with IBM Plex Sans Arabic falling back to system fonts.
 *
 * Logo: the real Streamline PNG (white-on-transparent) loaded from
 * `/logo.png` (served by express.static). Sits inside a navy rounded
 * tile that matches the brand mark in the mobile app's splash/header.
 *
 * Page accepts an optional `error` query param so the same template
 * renders both the empty form and the "wrong password" state without
 * needing a separate template engine.
 */

interface RenderOpts {
  /** The opaque blob the /authorize handler echoes back on POST so
   *  it can resume the redirect dance without re-parsing query params.
   *  Stored in a hidden form field. */
  request_id: string;
  /** Optional error message to render under the form (Arabic). */
  error?: string | null;
  /** Pre-filled email so a failed login doesn't make the vendor retype it. */
  username?: string;
  /** Display name of the OAuth client asking for access ("Claude" usually). */
  client_name?: string;
  /** `code` = sign in with a one-time code sent by email. */
  mode?: 'password' | 'code';
  /** Code mode: the code was sent, so show the code field. */
  code_sent?: boolean;
  /** Neutral notice (e.g. "the code was sent", "the invitation was resent"). */
  info?: string | null;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderLoginPage(opts: RenderOpts): string {
  const error = opts.error ? escape(opts.error) : '';
  const username = opts.username ? escape(opts.username) : '';
  const clientName = opts.client_name ? escape(opts.client_name) : 'Claude';
  const info = opts.info ? escape(opts.info) : '';
  const requestId = escape(opts.request_id);
  const switchForm = (step: string, label: string) => `
    <form method="POST" action="/oauth/authorize" class="switch">
      <input type="hidden" name="request_id" value="${requestId}" />
      <input type="hidden" name="step" value="${step}" />
      <input type="hidden" name="username" value="${username}" />
      <button type="submit" class="link">${label}</button>
    </form>`;
  const passwordForm = `
    <form method="POST" action="/oauth/authorize" autocomplete="on">
      <input type="hidden" name="request_id" value="${requestId}" />
      <div class="field">
        <label for="username">البريد الإلكتروني أو رقم الجوال</label>
        <input type="text" id="username" name="username" value="${username}" required autofocus autocomplete="username" />
      </div>
      <div class="field">
        <label for="password">كلمة المرور</label>
        <input type="password" id="password" name="password" required autocomplete="current-password" />
      </div>
      <button type="submit" class="submit">تسجيل الدخول والموافقة</button>
    </form>
    ${switchForm('code_mode', 'الدخول برمز على البريد')}`;
  const codeForm = opts.code_sent
    ? `
    <form method="POST" action="/oauth/authorize" autocomplete="off">
      <input type="hidden" name="request_id" value="${requestId}" />
      <input type="hidden" name="step" value="verify_code" />
      <input type="hidden" name="username" value="${username}" />
      <div class="field">
        <label for="code">رمز الدخول المرسل إلى ${username}</label>
        <input type="text" id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autofocus autocomplete="one-time-code" class="code" />
      </div>
      <button type="submit" class="submit">تسجيل الدخول والموافقة</button>
    </form>
    ${switchForm('send_code', 'إعادة إرسال الرمز')}
    ${switchForm('password_mode', 'الدخول بكلمة المرور')}`
    : `
    <form method="POST" action="/oauth/authorize" autocomplete="on">
      <input type="hidden" name="request_id" value="${requestId}" />
      <input type="hidden" name="step" value="send_code" />
      <div class="field">
        <label for="username">البريد الإلكتروني</label>
        <input type="email" id="username" name="username" value="${username}" required autofocus autocomplete="email" />
      </div>
      <button type="submit" class="submit">أرسل رمز الدخول</button>
    </form>
    ${switchForm('password_mode', 'الدخول بكلمة المرور')}`;
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>ربط Streamline مع ${clientName}</title>
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: 'IBM Plex Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif;
      background: linear-gradient(180deg, #0F1F35 0%, #1A3050 50%, #0F1F35 100%);
      min-height: 100vh;
      color: #0F1F35;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #fff;
      width: 100%;
      max-width: 420px;
      border-radius: 24px;
      padding: 32px 28px 28px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.35);
    }
    .brand {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .brand-mark {
      width: 76px;
      height: 76px;
      border-radius: 20px;
      background: #0F1F35;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 20px rgba(15,31,53,0.3);
      padding: 12px;
    }
    .brand-mark img { width: 100%; height: 100%; object-fit: contain; display: block; }
    .brand h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
      color: #0F1F35;
    }
    .brand .sub {
      font-size: 13px;
      color: #5A6A7E;
      text-align: center;
      line-height: 1.5;
    }
    .field { margin-bottom: 14px; }
    label {
      display: block;
      font-size: 12px;
      color: #5A6A7E;
      margin-bottom: 6px;
      font-weight: 600;
    }
    input[type="email"], input[type="text"], input[type="password"] {
      width: 100%;
      padding: 12px 14px;
      border: 1.5px solid #E2E8F0;
      border-radius: 12px;
      font-size: 15px;
      font-family: inherit;
      background: #F8FAFC;
      color: #0F1F35;
      transition: border-color 0.15s, background 0.15s;
      direction: ltr;
      text-align: right;
    }
    input:focus {
      outline: none;
      border-color: #5BD7C8;
      background: #fff;
    }
    .error {
      background: #FEE2E2;
      color: #991B1B;
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 14px;
      border: 1px solid #FCA5A5;
    }
    .submit {
      width: 100%;
      padding: 14px;
      background: #5BD7C8;
      color: #0F1F35;
      border: none;
      border-radius: 14px;
      font-size: 15px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      margin-top: 4px;
      transition: transform 0.1s, background 0.15s;
    }
    .submit:hover { background: #4BC4B5; }
    .submit:active { transform: scale(0.98); }
    .footer {
      margin-top: 20px;
      font-size: 11px;
      color: #94A3B8;
      text-align: center;
      line-height: 1.6;
    }
    .footer strong { color: #5A6A7E; }
    .info {
      background: #ECFDF5;
      color: #065F46;
      padding: 10px 14px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 14px;
      border: 1px solid #A7F3D0;
    }
    .switch { margin-top: 10px; text-align: center; }
    .link {
      background: none;
      border: none;
      color: #0F5A78;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      padding: 6px;
    }
    .link:hover { text-decoration: underline; }
    input.code { letter-spacing: 8px; text-align: center; font-size: 20px; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <div class="brand-mark" aria-hidden="true">
        <img src="/logo.png" alt="Streamline" />
      </div>
      <h1>ربط حسابك مع ${clientName}</h1>
      <div class="sub">سجل دخولك بحساب Streamline عشان نعطي ${clientName} الصلاحية لإدارة حجوزاتك وخدماتك.</div>
    </div>

    ${error ? `<div class="error">${error}</div>` : ''}
    ${info ? `<div class="info">${info}</div>` : ''}

    ${opts.mode === 'code' ? codeForm : passwordForm}

    <div class="footer">
      ${clientName} رح يقدر يقرا ويعدّل بياناتك في Streamline حسب صلاحياتك.<br/>
      تقدر تلغي الربط في أي وقت من <strong>إعدادات Claude</strong>.
    </div>
  </main>
</body>
</html>`;
}
