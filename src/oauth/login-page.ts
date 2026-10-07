/**
 * The login + consent page served at /oauth/authorize — one self-contained
 * HTML document in the partner-portal design of streamline.com.sa
 * (black on light, charcoal brand panel, Cairo).
 *
 * Sign-in options: password, a code emailed by the backend, Google and Apple
 * (each provider button shows only when its client id is configured).
 */
import { readFileSync } from 'node:fs';

interface RenderOpts {
  /** Opaque id of the pending authorize request (hidden field). */
  request_id: string;
  error?: string | null;
  username?: string;
  /** Display name of the OAuth client ("Claude" usually). */
  client_name?: string;
  /** `code` = sign in with a one-time code sent by email. */
  mode?: 'password' | 'code';
  /** Code mode: the code was sent, so show the code field. */
  code_sent?: boolean;
  info?: string | null;
  /** Link shown with `info`, e.g. partner sign-up when a Google account has no business yet. */
  info_link?: { href: string; label: string } | null;
}

const SITE_URL = (process.env.STREAMLINE_WEB_URL || 'https://streamline.com.sa').replace(/\/+$/, '');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || '';
const APPLE_REDIRECT_URI = process.env.APPLE_REDIRECT_URI || '';

export const partnerSignupUrl = `${SITE_URL}/register-service-provider-account`;

function brandSvg(file: string): string {
  try {
    return readFileSync(new URL(`../../public/brand/${file}`, import.meta.url), 'utf8')
      .replace(/<\?xml[^>]*>/, '')
      .replace(/<svg[^>]*>/, (tag) => tag.replace(/\s(?:width|height|color)="[^"]*"/g, ''));
  } catch {
    return '';
  }
}

const LOCKUP = brandSvg('streamline-lockup.svg');
const MARK = brandSvg('streamline-mark.svg');

const icon = (paths: string) =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  mail: icon('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>'),
  lock: icon('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  user: icon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  eye: icon('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  arrow: icon('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>'),
  link: icon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  alert: icon('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
  info: icon('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
  shield: icon('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  calendar: icon('<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'),
  scissors: icon('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>'),
  chart: icon('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'),
  key: icon('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>'),
};

const GOOGLE_LOGO = `<svg width="24" height="24" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.1 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

const APPLE_LOGO = `<svg width="22" height="22" viewBox="0 0 384 512" fill="currentColor" aria-hidden="true"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>`;

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLES = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:'Cairo',-apple-system,BlinkMacSystemFont,'Segoe UI',Tahoma,sans-serif;color:#2d2d2d;-webkit-font-smoothing:antialiased}
h1,p{margin:0}
.auth-page{--ink:#1f2328;--muted:#5d6b75;--soft:#8e9ca6;--fill:#f2f4f5;--line:#e5e8eb;--dark:#2d2d2d;--danger:#d93d42;position:relative;display:flex;align-items:center;justify-content:center;min-height:100vh;min-height:100dvh;padding:32px 20px;overflow:hidden;background:radial-gradient(860px 520px at 10% -10%,rgba(45,45,45,.07),transparent 62%),#f4f5f6}
.auth-page::before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(45,45,45,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(45,45,45,.055) 1px,transparent 1px);background-size:44px 44px;-webkit-mask-image:radial-gradient(ellipse at center,#000 25%,transparent 72%);mask-image:radial-gradient(ellipse at center,#000 25%,transparent 72%);pointer-events:none}
.auth-frame{position:relative;z-index:1;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.08fr);width:100%;max-width:960px;min-height:600px;overflow:hidden;background:#fff;border-radius:30px;box-shadow:0 40px 90px -40px rgba(0,0,0,.35),0 2px 8px rgba(0,0,0,.05)}
.auth-card{display:flex;flex-direction:column;min-width:0;padding:38px 46px 30px}
.auth-card__head{display:flex;flex-direction:column;gap:6px;margin-bottom:24px}
.auth-card__head h1{font-size:26px;font-weight:800;line-height:1.35;color:var(--ink)}
.auth-card__head p{font-size:15px;line-height:1.7;color:var(--muted)}
.auth-kicker{display:inline-flex;align-items:center;gap:7px;align-self:flex-start;margin-bottom:4px;padding:5px 12px;border-radius:999px;background:#eef0f2;font-size:12.5px;font-weight:800;color:var(--dark)}
.auth-card__badge{display:none}
.auth-form{display:flex;flex-direction:column;gap:14px;margin:0}
.auth-field__box{position:relative;display:flex;align-items:center;gap:10px;height:56px;padding-inline:16px;border:1.5px solid transparent;border-radius:16px;background:var(--fill);transition:background .18s ease,border-color .18s ease,box-shadow .18s ease}
.auth-field__box:focus-within{border-color:var(--dark);background:#fff;box-shadow:0 0 0 4px rgba(45,45,45,.1)}
.auth-field__icon{flex:none;display:grid;font-size:19px;color:var(--soft)}
.auth-field__box:focus-within .auth-field__icon{color:var(--dark)}
.auth-field__input{flex:1;width:100%;min-width:0;height:100%;padding:0;border:0;outline:0;background:transparent;font:inherit;font-size:16px;font-weight:600;color:var(--ink)}
.auth-field__input::placeholder{font-weight:500;color:#9aa5ad}
.auth-field__input--code{direction:ltr;text-align:center;letter-spacing:10px;font-size:22px;font-weight:800}
.auth-field__toggle{display:grid;place-items:center;flex:none;padding:6px;border:0;border-radius:10px;background:transparent;color:var(--soft);font-size:18px;cursor:pointer}
.auth-field__toggle:hover,.auth-field__toggle.is-on{color:var(--dark)}
.auth-row{display:flex;justify-content:flex-start}
.auth-link{padding:0;border:0;background:none;font:inherit;font-size:14px;font-weight:700;color:var(--dark);text-decoration:none;cursor:pointer}
.auth-link:hover{color:#000;text-decoration:underline}
.auth-submit{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:56px;margin-top:4px;border:0;border-radius:16px;background:linear-gradient(135deg,#3d3d3d 0%,#2d2d2d 55%,#161616 100%);box-shadow:0 14px 26px -14px rgba(0,0,0,.6);font:inherit;font-size:16.5px;font-weight:800;color:#fff;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease,opacity .15s ease}
.auth-submit:hover:not(:disabled){transform:translateY(-1px)}
.auth-submit:disabled{opacity:.6;cursor:progress}
.auth-submit svg{font-size:19px}
.auth-submit.is-busy svg{display:none}
.auth-submit.is-busy::after{content:"";width:20px;height:20px;border:2.5px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.auth-ghost-link{display:inline-flex;align-items:center;justify-content:center;gap:8px;align-self:center;padding:6px 10px;border:0;border-radius:10px;background:none;font:inherit;font-size:14px;font-weight:700;color:var(--dark);cursor:pointer}
.auth-ghost-link:hover{background:#f2f4f5}
.auth-divider{display:flex;align-items:center;gap:14px;margin:22px 0 16px;font-size:13px;font-weight:600;color:#9aa5ad}
.auth-divider::before,.auth-divider::after{content:"";flex:1;height:1px;background:var(--line)}
.auth-social{display:flex;justify-content:center;gap:14px}
.auth-social form{margin:0}
.social-btn{position:relative;display:grid;place-items:center;flex:none;width:52px;height:52px;padding:0;border-radius:50%;border:1px solid #dadce0;background:#fff;cursor:pointer;transition:transform .15s ease,box-shadow .15s ease;font-size:22px;color:var(--dark)}
.social-btn:hover{transform:translateY(-1px);box-shadow:0 10px 20px -12px rgba(0,0,0,.45)}
.social-btn--apple{border-color:#000;background:#000;color:#fff}
.social-btn__gsi{position:absolute;inset:0;display:grid;place-items:center;opacity:0;pointer-events:none}
.social-btn__gsi>div{transform:scale(1.3)}
.social-btn--google.is-ready .social-btn__gsi{opacity:1;pointer-events:auto}
.notice{display:flex;align-items:flex-start;gap:10px;margin-bottom:16px;padding:12px 14px;border-radius:14px;font-size:14px;line-height:1.7}
.notice svg{flex:none;margin-top:3px;font-size:17px}
.notice--error{background:#fff4f4;border:1px solid #f3c9cb;color:#8f2a2e}
.notice--info{background:var(--fill);border:1px solid var(--line);color:#3a3f45}
.notice a{color:inherit;font-weight:800}
.auth-card__footer{display:flex;flex-direction:column;gap:12px;margin-top:auto;padding-top:24px;font-size:14px;color:var(--muted);text-align:center}
.auth-footer-row{display:flex;flex-wrap:wrap;justify-content:center;gap:6px}
.auth-legal{display:flex;align-items:center;justify-content:center;gap:6px;font-size:12.5px;line-height:1.7;color:var(--soft)}
.auth-brand{position:relative;display:flex;flex-direction:column;justify-content:space-between;gap:32px;order:-1;padding:44px 42px;overflow:hidden;background:radial-gradient(420px 320px at 85% 8%,rgba(255,255,255,.09),transparent 65%),linear-gradient(165deg,#3a3a3a 0%,#2d2d2d 45%,#161616 100%);color:#fff}
.auth-brand::before,.auth-brand::after{content:"";position:absolute;border-radius:50%;border:1px solid rgba(255,255,255,.09);pointer-events:none}
.auth-brand::before{width:420px;height:420px;bottom:-170px;inset-inline-start:-140px}
.auth-brand::after{width:260px;height:260px;bottom:-90px;inset-inline-start:-60px}
.auth-brand__lockup{position:relative;display:block;width:132px;color:#fff;line-height:0}
.auth-brand__lockup svg,.auth-card__badge svg{display:block;width:100%;height:auto;overflow:visible}
.auth-brand__watermark{position:absolute;top:38px;inset-inline-end:-64px;width:260px;opacity:.06;pointer-events:none}
.auth-brand__headline{position:relative;margin:auto 0 0;font-size:30px;font-weight:800;line-height:1.5}
.auth-brand__perks{position:relative;display:grid;gap:12px;margin:0;padding:0;list-style:none}
.auth-brand__perks li{display:flex;align-items:center;gap:12px;font-size:15px;font-weight:700;color:rgba(255,255,255,.92)}
.auth-brand__perks span{display:grid;place-items:center;width:40px;height:40px;border-radius:13px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);font-size:18px}
body.is-busy .auth-card{pointer-events:none;opacity:.7}
@media (max-width:991.98px){
.auth-frame{grid-template-columns:1fr;max-width:480px;min-height:0}
.auth-brand{display:none}
.auth-card{padding:26px 30px 28px}
.auth-card__head{align-items:center;text-align:center}
.auth-card__head .auth-kicker{align-self:center}
.auth-card__badge{display:grid;place-items:center;width:64px;height:64px;margin-bottom:12px;border-radius:20px;background:linear-gradient(150deg,#3d3d3d 0%,#2d2d2d 55%,#161616 100%);box-shadow:0 16px 30px -16px rgba(0,0,0,.7);color:#fff}
.auth-card__badge span{display:block;width:26px;line-height:0}
}
@media (max-width:575.98px){
.auth-page{align-items:stretch;padding:0;background:radial-gradient(520px 280px at 50% -90px,rgba(45,45,45,.08),transparent 70%),#fff}
.auth-page::before{display:none}
.auth-frame{max-width:none;min-height:100vh;min-height:100dvh;border-radius:0;background:transparent;box-shadow:none}
.auth-card{padding:calc(22px + env(safe-area-inset-top,0px)) 20px 26px}
.auth-card__head h1{font-size:24px}
}
`;

export function renderLoginPage(opts: RenderOpts): string {
  const clientName = opts.client_name ? escape(opts.client_name) : 'Claude';
  const username = opts.username ? escape(opts.username) : '';
  const requestId = escape(opts.request_id);
  const hidden = `<input type="hidden" name="request_id" value="${requestId}" />`;
  const hasSocial = Boolean(GOOGLE_CLIENT_ID || APPLE_CLIENT_ID);

  const notices = [
    opts.error ? `<div class="notice notice--error" role="alert">${ICONS.alert}<div>${escape(opts.error)}</div></div>` : '',
    opts.info
      ? `<div class="notice notice--info" role="status">${ICONS.info}<div>${escape(opts.info)}${
          opts.info_link ? ` <a href="${escape(opts.info_link.href)}" target="_blank" rel="noopener">${escape(opts.info_link.label)}</a>` : ''
        }</div></div>`
      : '',
  ].join('');

  const switchTo = (step: string, label: string, iconSvg: string) => `
    <form method="POST" action="/oauth/authorize" class="auth-form">
      ${hidden}<input type="hidden" name="step" value="${step}" /><input type="hidden" name="username" value="${username}" />
      <button type="submit" class="auth-ghost-link">${iconSvg}${label}</button>
    </form>`;

  const passwordForm = `
    <form method="POST" action="/oauth/authorize" class="auth-form" data-busy autocomplete="on">
      ${hidden}
      <label class="auth-field__box">
        <span class="auth-field__icon">${ICONS.user}</span>
        <input class="auth-field__input" type="text" name="username" value="${username}" placeholder="البريد الإلكتروني أو رقم الجوال" aria-label="البريد الإلكتروني أو رقم الجوال" required autofocus autocomplete="username" dir="auto" />
      </label>
      <label class="auth-field__box">
        <span class="auth-field__icon">${ICONS.lock}</span>
        <input class="auth-field__input" type="password" id="password" name="password" placeholder="كلمة المرور" aria-label="كلمة المرور" required autocomplete="current-password" />
        <button type="button" class="auth-field__toggle" data-toggle-password aria-label="إظهار كلمة المرور" title="إظهار كلمة المرور">${ICONS.eye}</button>
      </label>
      <div class="auth-row"><a class="auth-link" href="${SITE_URL}/restore-password-dashboard" target="_blank" rel="noopener">نسيت كلمة المرور؟</a></div>
      <button type="submit" class="auth-submit">دخول وربط الحساب${ICONS.arrow}</button>
    </form>
    <div class="auth-divider">أو تابع باستخدام</div>
    <div class="auth-social">
      ${GOOGLE_CLIENT_ID ? `<div class="social-btn social-btn--google" title="المتابعة باستخدام Google">${GOOGLE_LOGO}<div class="social-btn__gsi" id="google-host"></div></div>` : ''}
      ${APPLE_CLIENT_ID ? `<button type="button" class="social-btn social-btn--apple" id="apple-btn" aria-label="المتابعة باستخدام Apple" title="المتابعة باستخدام Apple">${APPLE_LOGO}</button>` : ''}
      <form method="POST" action="/oauth/authorize">
        ${hidden}<input type="hidden" name="step" value="code_mode" /><input type="hidden" name="username" value="${username}" />
        <button type="submit" class="social-btn" aria-label="الدخول برمز على البريد" title="الدخول برمز على البريد">${ICONS.mail}</button>
      </form>
    </div>`;

  const codeForm = opts.code_sent
    ? `
    <form method="POST" action="/oauth/authorize" class="auth-form" data-busy autocomplete="off">
      ${hidden}<input type="hidden" name="step" value="verify_code" /><input type="hidden" name="username" value="${username}" />
      <label class="auth-field__box">
        <span class="auth-field__icon">${ICONS.key}</span>
        <input class="auth-field__input auth-field__input--code" type="text" name="code" inputmode="numeric" pattern="[0-9٠-٩]{6}" maxlength="6" placeholder="••••••" aria-label="رمز الدخول المرسل إلى ${username}" required autofocus autocomplete="one-time-code" />
      </label>
      <button type="submit" class="auth-submit">دخول وربط الحساب${ICONS.arrow}</button>
    </form>
    ${switchTo('send_code', 'إعادة إرسال الرمز', ICONS.mail)}
    ${switchTo('password_mode', 'الدخول بكلمة المرور', ICONS.lock)}`
    : `
    <form method="POST" action="/oauth/authorize" class="auth-form" data-busy autocomplete="on">
      ${hidden}<input type="hidden" name="step" value="send_code" />
      <label class="auth-field__box">
        <span class="auth-field__icon">${ICONS.mail}</span>
        <input class="auth-field__input" type="email" name="username" value="${username}" placeholder="البريد الإلكتروني" aria-label="البريد الإلكتروني" required autofocus autocomplete="email" dir="ltr" />
      </label>
      <button type="submit" class="auth-submit">أرسل رمز الدخول${ICONS.arrow}</button>
    </form>
    ${switchTo('password_mode', 'الدخول بكلمة المرور', ICONS.lock)}`;

  const socialScript = hasSocial
    ? `
<form method="POST" action="/oauth/authorize" id="social-form" hidden>
  ${hidden}<input type="hidden" name="step" value="social" /><input type="hidden" name="provider" /><input type="hidden" name="id_token" /><input type="hidden" name="first_name" /><input type="hidden" name="last_name" />
</form>
<script>
(function () {
  var cfg = ${JSON.stringify({ google: GOOGLE_CLIENT_ID, apple: APPLE_CLIENT_ID, appleRedirect: APPLE_REDIRECT_URI }).replace(/</g, '\\u003c')};
  var form = document.getElementById('social-form');
  function send(provider, token, first, last) {
    form.elements.provider.value = provider;
    form.elements.id_token.value = token;
    form.elements.first_name.value = first || '';
    form.elements.last_name.value = last || '';
    document.body.classList.add('is-busy');
    form.submit();
  }
  function load(src, done) {
    var s = document.createElement('script');
    s.src = src; s.async = true; s.onload = done;
    document.head.appendChild(s);
  }
  var host = document.getElementById('google-host');
  if (cfg.google && host) {
    load('https://accounts.google.com/gsi/client', function () {
      if (!window.google || !google.accounts || !google.accounts.id) return;
      google.accounts.id.initialize({ client_id: cfg.google, callback: function (r) { if (r && r.credential) send('google', r.credential); } });
      google.accounts.id.renderButton(host, { type: 'icon', theme: 'outline', size: 'large', shape: 'circle', locale: 'ar' });
      var tries = 0;
      (function reveal() {
        var frame = host.querySelector('iframe');
        if (frame && frame.offsetWidth > 0) { host.parentNode.classList.add('is-ready'); return; }
        if (tries++ < 60) setTimeout(reveal, 100);
      })();
    });
  }
  var apple = document.getElementById('apple-btn');
  if (cfg.apple && apple) {
    load('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js', function () {
      if (!window.AppleID) return;
      AppleID.auth.init({ clientId: cfg.apple, scope: 'name email', redirectURI: cfg.appleRedirect || location.origin + '/oauth/authorize', usePopup: true });
    });
    apple.addEventListener('click', function () {
      if (!window.AppleID) return;
      AppleID.auth.signIn().then(function (data) {
        var token = data && data.authorization && data.authorization.id_token;
        var name = (data && data.user && data.user.name) || {};
        if (token) send('apple', token, name.firstName, name.lastName);
      }).catch(function () {});
    });
  }
})();
</script>`
    : '';

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>ربط Streamline مع ${clientName}</title>
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@500;600;700;800&display=swap" rel="stylesheet">
  <style>${STYLES}</style>
</head>
<body>
  <div class="auth-page">
    <div class="auth-frame">
      <main class="auth-card">
        <div class="auth-card__head">
          <span class="auth-card__badge" aria-hidden="true"><span>${MARK}</span></span>
          <span class="auth-kicker">${ICONS.link}ربط ${clientName}</span>
          <h1>${opts.mode === 'code' ? 'الدخول برمز على البريد' : `اربط حسابك مع ${clientName}`}</h1>
          <p>${opts.mode === 'code' && opts.code_sent ? `أدخل الرمز المرسل إلى ${username}` : `سجّل دخولك بحساب الشريك عشان يدير ${clientName} حجوزاتك وخدماتك معك.`}</p>
        </div>
        ${notices}
        ${opts.mode === 'code' ? codeForm : passwordForm}
        <div class="auth-card__footer">
          <div class="auth-footer-row"><span>ليس لديك حساب شريك؟</span><a class="auth-link" href="${partnerSignupUrl}" target="_blank" rel="noopener">إنشاء حساب شريك</a></div>
          <p class="auth-legal">${ICONS.shield}${clientName} يعمل بصلاحيات حسابك، وتقدر تلغي الربط من إعداداته في أي وقت.</p>
        </div>
      </main>
      <aside class="auth-brand" aria-hidden="true">
        <span class="auth-brand__lockup">${LOCKUP}</span>
        <img src="/logo.png" alt="" class="auth-brand__watermark" />
        <div class="auth-brand__headline">صالونك كله<br />في محادثة وحدة</div>
        <ul class="auth-brand__perks">
          <li><span>${ICONS.calendar}</span>حجوزاتك وتقويمك</li>
          <li><span>${ICONS.scissors}</span>خدماتك وعروضك</li>
          <li><span>${ICONS.chart}</span>تقاريرك وأرباحك</li>
        </ul>
      </aside>
    </div>
  </div>
  <script>
  (function () {
    var toggle = document.querySelector('[data-toggle-password]');
    if (toggle) toggle.addEventListener('click', function () {
      var input = document.getElementById('password');
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.classList.toggle('is-on', show);
      toggle.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
    });
    document.querySelectorAll('form[data-busy]').forEach(function (f) {
      f.addEventListener('submit', function () {
        var b = f.querySelector('.auth-submit');
        if (b) setTimeout(function () { b.disabled = true; b.classList.add('is-busy'); }, 0);
      });
    });
  })();
  </script>${socialScript}
</body>
</html>`;
}
