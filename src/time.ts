/**
 * Saudi-timezone helpers.
 *
 * The Streamline backend stores booking times as unix seconds in the
 * `bookings.booking_timestamp` column. When the mobile app or Claude
 * sends "Saturday May 23 9 PM" the user MEANS 9 PM Riyadh local time,
 * and the server converts that to the appropriate UTC instant.
 *
 * The problem Claude hit in conversation: it tried to compute the unix
 * timestamp for a Saudi-local datetime in its head and got a value that
 * was a few days off — there's no way for a model to reliably do "what
 * unix is 2026-05-23 21:00 Asia/Riyadh" without an actual clock.
 *
 * Fix: the MCP server does this conversion itself.
 *
 *   • `nowSaudi()` returns the current instant formatted for the
 *     vendor's perspective (the `get_current_time` tool exposes it).
 *   • `saudiLocalToUnix(date, time)` takes "YYYY-MM-DD" + "HH:MM" in
 *     Riyadh local time and returns the unix seconds the backend
 *     expects. Bookings accept this as `local_datetime` so Claude
 *     never has to do timezone math.
 *
 * Saudi Arabia is UTC+3 year-round (no DST), so we can hard-code the
 * offset. Using `+03:00` in an ISO 8601 string lets Node parse it
 * correctly regardless of the machine's local timezone (claude.ai
 * users running this MCP may be anywhere in the world).
 */

const SAUDI_TZ = 'Asia/Riyadh';

/**
 * Convert a Saudi-local "YYYY-MM-DD HH:MM" pair to unix seconds.
 *
 * Throws when the date or time are malformed — booking creation
 * should refuse rather than silently land at an "Invalid Date".
 */
export function saudiLocalToUnix(date: string, time: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid date "${date}". Expected YYYY-MM-DD (Saudi local).`);
  }
  if (!/^\d{1,2}:\d{2}$/.test(time)) {
    throw new Error(`Invalid time "${time}". Expected HH:MM in 24h Saudi local.`);
  }
  // Normalise "9:00" → "09:00" so the ISO parser is happy.
  const [hRaw, m] = time.split(':');
  const h = hRaw.padStart(2, '0');
  // Wall-as-UTC wire convention (June-2026): `booking_timestamp` encodes
  // the vendor's WALL CLOCK as UTC seconds — the backend pins
  // `createFromTimestamp($ts, 'UTC')` and reproduces the exact wall time.
  // Parsing with `+03:00` here produced a TRUE epoch (wall − 3h), which
  // the pinned backend stored 3 hours early ("16:00 طلب، 13:00 انخزن").
  const iso = `${date}T${h}:${m}:00Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`Could not parse "${date} ${time}" as a Saudi local datetime.`);
  }
  return Math.floor(ms / 1000);
}

/** A stored wall-clock "YYYY-MM-DD HH:MM[:SS]" back to the same wire seconds. */
export function wallStringToUnix(value: unknown): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(value ?? ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) / 1000 : undefined;
}

/**
 * Single object with all the variations of "now" the model is likely
 * to want — readable date, readable time, raw unix, and the timezone
 * hint so Claude can format anything else correctly.
 */
export interface SaudiNow {
  /** Current unix seconds (timezone-independent absolute time). */
  unix_seconds: number;
  /** "YYYY-MM-DD" in Asia/Riyadh. */
  date: string;
  /** "HH:MM" in Asia/Riyadh, 24-hour. */
  time: string;
  /** Localised weekday in Arabic — useful for "اليوم السبت". */
  weekday_ar: string;
  /** "Saturday, 23 May 2026 21:00 (Asia/Riyadh)" — ready to display. */
  human: string;
  /** Constant — Saudi Arabia is UTC+3 year-round, no DST. */
  timezone: 'Asia/Riyadh';
  utc_offset_hours: 3;
}

export function nowSaudi(): SaudiNow {
  const now = new Date();

  // `Intl.DateTimeFormat` lets us format any instant in any timezone
  // regardless of the host machine's locale settings. Building the
  // pieces individually then re-assembling is more robust than
  // parsing a localised string back out.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAUDI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  // 'en-CA' returns hour as "24" at midnight — clamp to "00".
  const hour = get('hour') === '24' ? '00' : get('hour');
  const time = `${hour}:${get('minute')}`;

  const weekday_ar = new Intl.DateTimeFormat('ar', {
    timeZone: SAUDI_TZ,
    weekday: 'long',
  }).format(now);

  const human = new Intl.DateTimeFormat('en-GB', {
    timeZone: SAUDI_TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);

  return {
    unix_seconds: Math.floor(now.getTime() / 1000),
    date,
    time,
    weekday_ar,
    human: `${human} (${SAUDI_TZ})`,
    timezone: SAUDI_TZ,
    utc_offset_hours: 3,
  };
}
