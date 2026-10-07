/**
 * Tool definitions (v0.8, synced with backend staging/main ad2f810 / 3f21f1f).
 *
 * One umbrella tool per resource with an `action` enum; every field is
 * optional at the zod layer and each handler checks what its action needs.
 * Deletes are deliberately not exposed — deactivate instead.
 */
import { z } from 'zod';
import { VendorClient } from './vendor-client.js';
import { nowSaudi, saudiLocalToUnix } from './time.js';

// ════════════════════════════════════════════════════════════════════
//  PUBLIC SHAPE
// ════════════════════════════════════════════════════════════════════

/** A registered MCP tool. */
export interface ToolDef<I extends Record<string, any> = Record<string, any>> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler: (input: I) => Promise<unknown>;
}

// ════════════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ════════════════════════════════════════════════════════════════════

/** Drops null/undefined/'' so query strings never carry `?x=null`. */
function clean<T extends Record<string, any>>(o: T): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** Advisory (never blocking) for actions on an already-completed booking. */
function completedBookingNotice(detail: any, action: string): string | null {
  if (String(detail?.status ?? '').toLowerCase() !== 'completed') return null;
  return `Booking #${detail?.id ?? '?'} is already completed and its invoice is issued. To ${action} it the backend issues a ZATCA credit/debit note against the original invoice (the original total stays frozen). Tell the vendor before confirming.`;
}

function attachNotice(result: any, notice: string | null): any {
  return notice ? { notice, result } : result;
}

/** Hides pre-computed VAT when the vendor doesn't issue tax invoices. */
function stripVatFields<T>(booking: T): T {
  if (!booking || typeof booking !== 'object') return booking;
  const cloned: any = JSON.parse(JSON.stringify(booking));
  const VAT_KEYS = ['vat', 'total_vat', 'tax', 'total_tax', 'vat_value', 'vat_percentage'];
  for (const k of VAT_KEYS) delete cloned[k];
  for (const list of [cloned.booking_items, cloned.service_lines, cloned.services]) {
    if (!Array.isArray(list)) continue;
    list.forEach((item: any) => {
      if (item && typeof item === 'object') for (const k of VAT_KEYS) delete item[k];
    });
  }
  return cloned;
}

/** Rows of a list response, paginated (`{data: [...]}`) or not. */
function rowsOf(res: any): any[] {
  if (Array.isArray(res)) return res;
  if (Array.isArray(res?.data)) return res.data;
  if (Array.isArray(res?.data?.data)) return res.data.data;
  return [];
}

/** A list response without Laravel's pagination links, which only cost tokens. */
function pageOf(res: any, map?: (row: any) => any): any {
  const page = res?.data;
  const summary = res?.summary ?? page?.summary;
  if (Array.isArray(page?.data)) {
    return clean({
      data: map ? page.data.map(map) : page.data,
      current_page: page.current_page,
      last_page: page.last_page,
      total: page.total,
      summary,
    });
  }
  if (Array.isArray(page)) return summary ? { data: map ? page.map(map) : page, summary } : map ? page.map(map) : page;
  return res;
}

const idLike = z.union([z.number(), z.string()]);

const hourPattern = /^\d{1,2}:\d{2}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dayEnum = z.enum(['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri']);

const hourRowSchema = z.object({
  day: dayEnum,
  start_time: z.string().regex(hourPattern, 'HH:MM (24h) e.g. "09:00"'),
  end_time: z.string().regex(hourPattern, 'HH:MM (24h) e.g. "21:00"'),
});

const localDateTime = z
  .object({
    date: z.string().regex(datePattern),
    time: z.string().regex(hourPattern),
  })
  .describe('Saudi-local date + time (YYYY-MM-DD, HH:MM 24h). The server converts it.');

/** Id-keyed map, sent as `key[<id>]=value` (Laravel parses it back into an array). */
const idKeyedMap = z.record(z.union([z.number(), z.string()]));

/**
 * A service variant row. `id` MUST be echoed on edit: the backend updates
 * known ids in place, creates rows without one, and soft-deletes missing ones.
 */
const subServiceRowSchema = z.object({
  id: idLike.optional(),
  name_ar: z.string().min(1),
  name_en: z.string().optional(),
  price: z.number().nonnegative(),
  service_time: z.number().positive(),
  extra_time: z.number().nonnegative().optional(),
  sort: z.number().int().optional(),
  is_active: z.boolean().optional(),
});

function bool01(v: boolean | undefined): '0' | '1' | undefined {
  if (v === undefined) return undefined;
  return v ? '1' : '0';
}

function flag01(v: any): '0' | '1' {
  return Number(v) || v === true ? '1' : '0';
}

function require(input: any, fields: string[], action: string): void {
  const missing = fields.filter(
    (f) => input[f] === undefined || input[f] === null || input[f] === '',
  );
  if (missing.length > 0) {
    throw new Error(
      `action="${action}" requires: ${missing.join(', ')}. Provide them and call again.`,
    );
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function bookingTimestamp(input: { local_datetime?: { date: string; time: string }; booking_timestamp?: number }): number | undefined {
  if (input.local_datetime) return saudiLocalToUnix(input.local_datetime.date, input.local_datetime.time);
  return input.booking_timestamp;
}

/** Laravel's `date_format:H:i` wants "09:00"; stored times come back as "09:00:00". */
function hhmm(v: any): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? ''));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : String(v ?? '');
}

function hourRows(rows: any): Array<{ day: string; start_time: string; end_time: string }> {
  return (Array.isArray(rows) ? rows : [])
    .filter((h: any) => h?.day && h?.start_time && h?.end_time)
    .map((h: any) => ({ day: h.day, start_time: hhmm(h.start_time), end_time: hhmm(h.end_time) }));
}

/** Saudi-local {date, time} as an ISO string with an explicit +03:00 offset. */
function saudiIso(at: { date: string; time: string }): string {
  return `${at.date}T${hhmm(at.time)}:00+03:00`;
}

const PERMISSION_GROUP_SLUGS: Record<string, string> = {
  Roles: 'roles',
  Reports: 'reports',
  Calendar: 'calendar',
  Customers: 'customers',
  Branches: 'branches',
  Wallets: 'wallets',
  Employees: 'employees',
  Sections: 'sections',
  Services: 'services',
  Bookings: 'bookings',
  Invoices: 'invoices',
  Offers: 'offers',
  'Promo Codes': 'promo-codes',
  Settings: 'settings',
  POS: 'pos',
  Permissions: 'permissions',
  Zatca: 'zatca',
  'Reminder Channels': 'reminder-channels',
  'Vendor Reminders': 'vendor-reminders',
  Reviews: 'reviews',
  'Cancellation Reasons': 'cancellation-reasons',
  Products: 'products',
  Bundles: 'bundles',
};

/** Permission catalogue as `group.action` names ↔ ids (the API only speaks ids and translated labels). */
async function permissionCatalogue(api: VendorClient): Promise<{ byName: Map<string, number>; byId: Map<number, string> }> {
  const grouped = await api.get('/permissions', { without_pagination: 'true' }, { 'Accept-Language': 'en' });
  const byName = new Map<string, number>();
  const byId = new Map<number, string>();
  for (const [label, rows] of Object.entries<any>(grouped || {})) {
    const group = PERMISSION_GROUP_SLUGS[label] ?? label.replace(/^api\./, '').toLowerCase().replace(/\s+/g, '-');
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = `${group}.${String(row.name).replace(/^api\./, '').toLowerCase()}`;
      byName.set(name, Number(row.id));
      byId.set(Number(row.id), name);
    }
  }
  return { byName, byId };
}

// ════════════════════════════════════════════════════════════════════
//  GLOBAL CONVENTIONS — shown once on get_profile
// ════════════════════════════════════════════════════════════════════

const GLOBAL_CONVENTIONS = `GLOBAL CONVENTIONS (every reply):
• Saudi product: money in SAR (٤٥ ر.س), time is Asia/Riyadh (UTC+3), the week starts on Saturday.
• When the user writes Arabic, reply in natural Najdi Saudi dialect (وش، ابي، تمام، أبشر، يعطيك العافية) — not MSA or other dialects. Follow the user if they switch to English.
• Ask with options: when you need a branch / employee / service / customer / date, list 2-4 real options you fetched with list tools and let the vendor pick. If only one fits, confirm it ("تقصد فرع النخيل؟").
• Time: call get_current_time before anything relative to "today"; pass local_datetime {date, time} (Saudi local) — never compute unix timestamps yourself.
• Ids are only for tool calls — refer to things by name in replies.
• VAT fields are removed when the vendor isn't ZATCA-active; then never mention tax.
• No deletes: suggest action="deactivate" instead.
• A 403 "هذه الميزة غير متاحة في باقتك الحالية" means the PLAN lacks the feature (see \`features\` on get_profile), not a permission problem — offer subscription action="packages", don't retry.
• Names and descriptions are Arabic only (name_en / description_en are unused).
• Before every write, restate the change with names, prices and times and wait for a clear yes.`;

// ════════════════════════════════════════════════════════════════════
//  TOOL BUILDER
// ════════════════════════════════════════════════════════════════════

export function buildTools(api: VendorClient): ToolDef[] {
  return [
    // ════════════════════════════════════════════════════════════════
    //  STANDALONES
    // ════════════════════════════════════════════════════════════════

    {
      name: 'get_profile',
      description:
        'The logged-in account: name, contact, role, permissions, `features` (package feature map: streamline_ai, google_reviews, google_calendar, whatsapp_notifications, advanced_reports, live_activity, zatca, products, online_payment_fast), `account_active` (0 = blocked by admin), `subscription_valid` (0 = expired → subscription action="packages"), `has_password`. Call it first.\n\n' +
        GLOBAL_CONVENTIONS,
      inputSchema: z.object({}),
      handler: async () => api.get('/profile'),
    },

    {
      name: 'get_current_time',
      description:
        'Current Saudi date/time (Asia/Riyadh): `date` (YYYY-MM-DD), `time` (HH:MM), `weekday_ar`, `human`. Call it before anything relative to today, then pass local_datetime to booking actions.',
      inputSchema: z.object({}),
      handler: async () => nowSaudi(),
    },

    {
      name: 'get_wallet',
      description:
        'Wallet: `balance` (credits minus debits; with branch_id it is that branch\'s net) and transactions (value, type credit/debit, description, category, branch). Optional branch_id, page, per_page. Online-payment dues owed to the vendor are in online_payment action="payouts".',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(50).optional(),
      }),
      handler: async (input) => api.get('/wallet', clean(input)),
    },

    {
      name: 'get_reports',
      description:
        'Report numbers for a calendar period (it includes the rest of the period, so upcoming confirmed bookings count). period: day, week (Sun-Sat), month, 3months (quarter), 6months (half year), 9months, year. type:\n• home (default) — bookings_count, bookings_total_amount, customers_count, services_count, offers_count, employees_commissions, plus bookings_count_chart / bookings_value_chart [{x_key, value}] (x_key = hour for day, weekday 1=Sun for week, day of month for month, month number for longer periods). Note: these totals also count no-shows and unconfirmed bookings — say "حجوزات غير ملغاة" rather than "مكتملة".\n• services / offers / employees — top 10 by number of bookings.\n• customers — total, active %, new customers (by sign-up date), new %.\n• employees_commissions — commission per employee on completed bookings (optional employee_id).\nOptional branch_id. For exact paid revenue, sum completed bookings via booking action="list".',
      inputSchema: z.object({
        type: z
          .enum(['home', 'services', 'offers', 'customers', 'employees', 'employees_commissions'])
          .optional()
          .default('home'),
        period: z.enum(['day', 'week', 'month', '3months', '6months', '9months', 'year']).default('month'),
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
      }),
      handler: async (input) => api.get('/reports', clean({ type: 'home', ...input })),
    },

    {
      name: 'get_calendar',
      description:
        'Day view for one date (YYYY-MM-DD). Optional branch_id (omit = all branches) and employee_id. Returns employees (that weekday\'s hours, breaks, busy window), bookings (one row per employee segment: a multi-service visit split across specialists shows once per specialist with the same booking id), and external_busy (Google Calendar blocks). Cancelled bookings and products-only counter sales are not on the calendar. Pass raw=true for the unprocessed payload.',
      inputSchema: z.object({
        date: z.string().regex(datePattern),
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
        raw: z.boolean().optional(),
      }),
      handler: async (input) => {
        const res = await api.post(
          '/calendar',
          clean({ date: input.date, branch_id: input.branch_id, employee_id: input.employee_id }),
          { multipart: true },
        );
        if (input.raw) return res;
        const weekday = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][
          new Date(`${input.date}T00:00:00Z`).getUTCDay()
        ];
        const span = (rows: any[]) =>
          (rows || [])
            .filter((h: any) => h?.day === weekday)
            .map((h: any) => `${String(h.start_time).slice(0, 5)}-${String(h.end_time).slice(0, 5)}`);
        const at = (v: any) => (typeof v === 'string' ? v.slice(0, 16) : v);
        return {
          date: input.date,
          employees: (res?.employees || []).map((e: any) => clean({
            id: e.id,
            name: e.name,
            hours: span(e.working_hours).join(', ') || undefined,
            breaks: span(e.break_hours).join(', ') || undefined,
            busy: e.busy_from ? `${at(e.busy_from)} → ${e.busy_to ? at(e.busy_to) : 'open'}` : undefined,
          })),
          bookings: (res?.employees_bookings || []).flatMap((group: any) =>
            (group.bookings || []).map((b: any) => clean({
              id: b.id,
              employee_id: group.id,
              employee: group.name,
              start: at(b.segment_start ?? b.start_time),
              end: at(b.segment_end ?? b.end_time),
              services: Array.isArray(b.service_names) ? b.service_names.join('، ') : undefined,
              customer: b.customer?.name,
              phone: b.customer?.phone,
              status: b.status,
              paid: String(b.payment_status) === '1',
              item_status: b.item_status,
              split_visit: Number(b.segments_count) > 1 ? true : undefined,
              home: b.is_home_service ? true : undefined,
              address: b.is_home_service ? b.customer_address : undefined,
              awaiting_approval: b.awaiting_approval ? true : undefined,
              branch_id: b.branch_id,
            })),
          ),
          external_busy: res?.external_busy || [],
        };
      },
    },

    {
      name: 'preview_booking',
      description:
        'Price, duration, free time slots and specialist options for a possible booking, without creating it (the POS calculator). Pass branch_id + service_ids / offer_ids / product_ids; optional employee_id, employee_assignments, any_employee, customer_id (applies their prepaid bundle), sub_service_ids, prices, durations, discount, promo_code. Without a cart it returns the branch catalogue (sections, offers, employees). Show the breakdown and offer to book, adjust or drop it.',
      inputSchema: z.object({
        branch_id: idLike,
        employee_id: idLike.optional(),
        employee_assignments: idKeyedMap.optional(),
        any_employee: z.boolean().optional(),
        customer_id: idLike.optional(),
        service_ids: z.array(idLike).min(1).optional(),
        offer_ids: z.array(idLike).min(1).optional(),
        product_ids: z.array(idLike).min(1).optional(),
        product_prices: idKeyedMap.optional(),
        sub_service_ids: idKeyedMap.optional(),
        prices: idKeyedMap.optional(),
        durations: idKeyedMap.optional(),
        discount: z.number().nonnegative().optional(),
        promo_code: z.string().optional(),
      }),
      handler: async (input) =>
        api.post(
          '/pos',
          clean({ ...input, any_employee: bool01(input.any_employee) }),
          { multipart: true },
        ),
    },

    {
      name: 'list_permissions',
      description:
        'Permissions a role can hold, as { group: [actions] } — e.g. bookings: [list, view, create, edit, delete]. A permission name is "<group>.<action>" (bookings.list, promo-codes.edit, pos.create). Present them grouped in Arabic, not as raw names.',
      inputSchema: z.object({}),
      handler: async () => {
        const { byName } = await permissionCatalogue(api);
        const grouped: Record<string, string[]> = {};
        for (const name of byName.keys()) {
          const [group, action] = name.split('.');
          (grouped[group] ||= []).push(action);
        }
        return grouped;
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — booking
    // ════════════════════════════════════════════════════════════════

    {
      name: 'booking',
      description:
        'Bookings. ACTIONS:\n' +
        '• list — filters: branch_id, employee_id, customer_id, status (confirmed/completed/canceled/missed/not_confirmed), exclude_status[], date (YYYY-MM-DD) with optional date_to for a range, page, per_page.\n' +
        '• get — id. `service_lines[]` holds one row per service (id, name, employee, start/end, status); `awaiting_approval` marks a pending home-service request.\n' +
        '• create — branch_id + at least one of service_ids / offer_ids / product_ids. Staff for services/offers: employee_id (one specialist for all), or employee_assignments {"service:<service_id>" | "offer:<offer_id>:<service_id>" | "offer:<offer_id>": employee_id} (keys left out = any free specialist), or any_employee=true (may fail with "no specialist available"). Time: local_datetime (omit = now). Products only = a counter sale: no staff or time needed (employee_id = optional seller); it is rung up as completed unless complete=false. Optional: customer_id (omit = walk-in "عميل تلقائي", never ask for one the vendor didn\'t mention), sub_service_ids (REQUIRED for a service with variants: {"<service_id>": <sub_service_id>}), product_prices, prices / durations (per service id), offer_prices / offer_durations (per offer id), discount (flat SAR), notes, payment_way (cash; card payments go through payment_link), apply_bundles (default true: an active prepaid bundle of the customer covers matching lines), complete=true (ring up the sale now: completes it and marks it paid).\n' +
        '• cancel / complete / mark_no_show — status only; lines, staff and prices stay. cancel takes optional cancellation_reason or cancel_reason_id.\n' +
        '• approve / reject — decide a pending home-service request (awaiting_approval=true); reject takes an optional reason shown to the customer. Never cancel or complete such a request.\n' +
        '• item_status — one service of a visit: id + item_id (a service_lines id) + item_status (pending/completed/canceled/missed). The visit completes once every service is completed.\n' +
        '• reschedule — id + local_datetime. Each service keeps its specialist unless employee_id (moves all services to one person) or item_employees {"<service_line_id>": employee_id}. Optional duration_minutes = new total length. The employee must work in the booking\'s branch.\n' +
        '• update_notes — id + notes (≥3 chars); mode append (default replace).\n' +
        '• set_customer — id + customer_id; omit customer_id to make it a walk-in. Not allowed once completed.\n' +
        '• payment — live gateway details of an online payment (card, status, refunds).\n' +
        'A booking with a live QR payment request is locked (409) until that request is paid or cancelled — see the payment_link tool. Confirm every write with the vendor first.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'cancel',
          'complete',
          'mark_no_show',
          'approve',
          'reject',
          'item_status',
          'reschedule',
          'update_notes',
          'set_customer',
          'payment',
        ]),
        id: idLike.optional(),
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
        customer_id: idLike.optional(),
        status: z.enum(['confirmed', 'completed', 'canceled', 'missed', 'not_confirmed']).optional(),
        exclude_status: z.array(z.enum(['confirmed', 'completed', 'canceled', 'missed', 'not_confirmed'])).optional(),
        date: z.string().regex(datePattern).optional(),
        date_to: z.string().regex(datePattern).optional().describe('list: last day of a date range (inclusive).'),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        service_ids: z.array(idLike).min(1).optional(),
        offer_ids: z.array(idLike).min(1).optional(),
        product_ids: z.array(idLike).min(1).optional(),
        product_prices: idKeyedMap.optional().describe('Per-product price (SAR), keyed by product id.'),
        employee_assignments: idKeyedMap.optional(),
        any_employee: z.boolean().optional(),
        sub_service_ids: idKeyedMap.optional(),
        prices: idKeyedMap.optional(),
        durations: idKeyedMap.optional(),
        offer_prices: idKeyedMap.optional(),
        offer_durations: idKeyedMap.optional(),
        discount: z.number().nonnegative().optional(),
        local_datetime: localDateTime.optional(),
        booking_timestamp: z.number().int().optional(),
        notes: z.string().optional(),
        mode: z.enum(['append', 'replace']).optional(),
        payment_way: z.enum(['cash', 'online']).optional(),
        apply_bundles: z.boolean().optional(),
        complete: z.boolean().optional(),
        cancellation_reason: z.string().min(2).max(500).optional(),
        cancel_reason_id: idLike.optional(),
        reason: z.string().max(255).optional(),
        item_id: idLike.optional(),
        item_status: z.enum(['pending', 'completed', 'canceled', 'missed']).optional(),
        item_employees: idKeyedMap.optional(),
        duration_minutes: z.number().int().min(1).max(1440).optional(),
      }),
      handler: async (input) => {
        const zatca = await api.getZatcaState();
        const present = (b: any) => (zatca.active ? b : stripVatFields(b));
        const statusOnly = (id: any, body: Record<string, any>) =>
          api.putViaPost(`/bookings/${id}`, body, { multipart: true });

        switch (input.action) {
          case 'list': {
            const range = input.date && input.date_to
              ? { date_from: `${input.date} 00:00:00`, date_to: `${addDays(input.date_to, 1)} 00:00:00` }
              : {};
            const res = await api.getRaw(
              '/bookings',
              clean({
                branch_id: input.branch_id,
                employee_id: input.employee_id,
                user_id: input.customer_id,
                status: input.status,
                exclude_status: input.exclude_status,
                date: input.date,
                ...range,
                page: input.page,
                per_page: input.per_page,
              }),
            );
            return pageOf(res, zatca.active ? undefined : stripVatFields);
          }
          case 'get':
            require(input, ['id'], 'get');
            return present(await api.get(`/bookings/${input.id}`));
          case 'create': {
            require(input, ['branch_id'], 'create');
            const timed = (input.service_ids?.length ?? 0) > 0 || (input.offer_ids?.length ?? 0) > 0;
            if (!timed && !(input.product_ids?.length)) {
              throw new Error('action="create" needs service_ids, offer_ids or product_ids.');
            }
            if (input.complete && input.payment_way === 'online') {
              throw new Error('A completed sale can only be recorded as cash here. To collect a card payment, create the booking and use payment_link.');
            }
            const assigned = input.employee_assignments && Object.keys(input.employee_assignments).length > 0;
            if (timed && input.employee_id == null && !assigned && !input.any_employee) {
              throw new Error('action="create" needs employee_id, employee_assignments or any_employee=true for services/offers.');
            }
            const complete = input.complete ?? !timed;
            const nonEmpty = (m?: Record<string, any>) => (m && Object.keys(m).length > 0 ? m : undefined);
            const created: any = await api.post(
              '/bookings',
              clean({
                branch_id: input.branch_id,
                customer_id: input.customer_id,
                employee_id: input.employee_id,
                employee_assignments: nonEmpty(input.employee_assignments),
                any_employee: input.any_employee ? '1' : undefined,
                service_ids: input.service_ids,
                offer_ids: input.offer_ids,
                product_ids: input.product_ids,
                product_prices: nonEmpty(input.product_prices),
                sub_service_ids: nonEmpty(input.sub_service_ids),
                prices: nonEmpty(input.prices),
                durations: nonEmpty(input.durations),
                offer_prices: nonEmpty(input.offer_prices),
                offer_durations: nonEmpty(input.offer_durations),
                discount: input.discount,
                booking_timestamp: bookingTimestamp(input),
                future_booking: complete ? '0' : '1',
                payment_way: input.payment_way ?? 'cash',
                apply_bundles: bool01(input.apply_bundles),
              }),
              { multipart: true },
            );
            const followUp: Record<string, any> = {};
            if (complete) Object.assign(followUp, { status: 'completed', payment_status: '1' });
            if (input.notes && input.notes.trim().length >= 3) followUp.notes = input.notes.trim();
            if (created?.id && Object.keys(followUp).length > 0) {
              return present(await statusOnly(created.id, followUp));
            }
            return present(created);
          }
          case 'cancel':
          case 'complete':
          case 'mark_no_show': {
            require(input, ['id'], input.action);
            const detail = await api.get(`/bookings/${input.id}`);
            if (detail?.awaiting_approval) {
              throw new Error('This is a pending home-service request — decide it with action="approve" or action="reject".');
            }
            const notice = completedBookingNotice(
              detail,
              input.action === 'cancel' ? 'cancel' : input.action === 'complete' ? 're-complete' : 'mark as no-show',
            );
            const body: Record<string, any> = {
              status: input.action === 'cancel' ? 'canceled' : input.action === 'complete' ? 'completed' : 'missed',
            };
            if (input.action === 'complete') body.payment_status = '1';
            if (input.action === 'cancel') {
              if (input.cancellation_reason) body.cancellation_reason = input.cancellation_reason;
              if (input.cancel_reason_id) body.cancel_reason_id = input.cancel_reason_id;
            }
            return attachNotice(present(await statusOnly(input.id, body)), notice);
          }
          case 'approve':
            require(input, ['id'], 'approve');
            return present(await api.post(`/bookings/${input.id}/approve`));
          case 'reject':
            require(input, ['id'], 'reject');
            return present(
              await api.post(`/bookings/${input.id}/reject`, clean({ reason: input.reason?.trim() }), { multipart: true }),
            );
          case 'item_status':
            require(input, ['id', 'item_id', 'item_status'], 'item_status');
            return present(
              await api.post(
                `/bookings/${input.id}/items/${input.item_id}/status`,
                { status: input.item_status },
                { multipart: true },
              ),
            );
          case 'reschedule': {
            require(input, ['id'], 'reschedule');
            const timestamp = bookingTimestamp(input);
            if (timestamp === undefined) {
              throw new Error('action="reschedule" requires local_datetime.');
            }
            const detail = await api.get(`/bookings/${input.id}`);
            const body: Record<string, any> = { booking_timestamp: timestamp };
            if (input.duration_minutes) body.duration_minutes = input.duration_minutes;
            const lines: any[] = Array.isArray(detail?.service_lines) ? detail.service_lines : [];
            const overrides = input.item_employees ?? {};
            if (input.employee_id != null) {
              body.employee_id = input.employee_id;
            } else if (lines.length > 0 && lines.every((l) => l?.employee?.id || overrides[String(l.id)])) {
              body.items = lines.map((l) => ({ id: l.id, employee_id: overrides[String(l.id)] ?? l.employee.id }));
            } else {
              body.employee_id = detail?.employee?.id ?? detail?.employee_id;
            }
            return attachNotice(
              present(await api.post(`/bookings/${input.id}/reschedule`, body, { multipart: true })),
              completedBookingNotice(detail, 'reschedule'),
            );
          }
          case 'update_notes': {
            require(input, ['id', 'notes'], 'update_notes');
            let notes = input.notes!.trim();
            if (input.mode === 'append') {
              const detail = await api.get(`/bookings/${input.id}`);
              if (detail?.notes) notes = `${detail.notes}\n${notes}`;
            }
            if (notes.length < 3) throw new Error('notes must be at least 3 characters.');
            return present(await statusOnly(input.id, { notes }));
          }
          case 'set_customer':
            require(input, ['id'], 'set_customer');
            return present(await statusOnly(input.id, { customer_id: input.customer_id ?? '' }));
          case 'payment':
            require(input, ['id'], 'payment');
            return api.get(`/bookings/${input.id}/payment`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — branch
    // ════════════════════════════════════════════════════════════════

    {
      name: 'branch',
      description:
        'Branches.\nACTIONS:\n• list — optional q, active_only. • get — id.\n• create — name, address, lat, long, official_hours [{day, start_time, end_time}] (sat…fri, HH:MM; always the full week — it replaces the stored list). Use places_search → places_location to fill address/lat/long. Optional home delivery: offers_home_services, is_cloud (home-only branch, implies home services), home_pricing_type fixed (home_fixed_fee) or by_distance (home_pricing_tiers [{up_to_minutes, fee}], nearest first, the full list; the last tier is the coverage radius — places_reach shows drive times).\n• update — id + any field; the rest is echoed. sync_employee_hours=true also moves this branch\'s employees to the new hours. existing_images = gallery URLs to KEEP (others are deleted; uploads are dashboard-only).\n• activate / deactivate — id.\n• set_busy — id + busy_from (+ optional busy_until, else until clear_busy) pauses new bookings; available_when_busy=false also hides it. • clear_busy — id.\n• places_search (q) / places_details (place_id) / places_location (place_id → address, lat, long) / places_reverse (lat, lng → address) / places_reach (lat, lng → drive-time rays).\n• Google (package feature google_reviews): set_google_place (id + google_place_id, "" unlinks), set_google_reviews (id + show_google_reviews), google_stats (id), google_stats_refresh (id + scope all/employees/competitors; takes 40-90 s).',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'update',
          'activate',
          'deactivate',
          'set_busy',
          'clear_busy',
          'places_search',
          'places_details',
          'places_location',
          'places_reverse',
          'places_reach',
          'set_google_place',
          'set_google_reviews',
          'google_stats',
          'google_stats_refresh',
        ]),
        id: idLike.optional(),
        q: z.string().optional(),
        active_only: z.boolean().optional(),
        name: z.string().min(2).optional(),
        address: z.string().min(2).optional(),
        lat: z.union([z.string(), z.number()]).optional(),
        long: z.union([z.string(), z.number()]).optional(),
        lng: z.union([z.string(), z.number()]).optional().describe('places_reverse / places_reach longitude.'),
        city_id: idLike.optional(),
        region_id: idLike.optional(),
        country_id: idLike.optional(),
        official_hours: z.array(hourRowSchema).optional(),
        sync_employee_hours: z.boolean().optional(),
        offers_home_services: z.boolean().optional(),
        is_cloud: z.boolean().optional(),
        home_pricing_type: z.enum(['fixed', 'by_distance']).optional(),
        home_fixed_fee: z.number().nonnegative().optional(),
        home_pricing_tiers: z
          .array(z.object({ up_to_minutes: z.number().int().min(1), fee: z.number().nonnegative() }))
          .optional(),
        existing_images: z.array(z.string()).optional(),
        busy_from: localDateTime.optional(),
        busy_until: localDateTime.optional(),
        available_when_busy: z.boolean().optional(),
        place_id: z.string().optional(),
        google_place_id: z.string().max(255).optional(),
        show_google_reviews: z.boolean().optional(),
        scope: z.enum(['all', 'employees', 'competitors']).optional(),
      }),
      handler: async (input) => {
        const homeFields = (current: any) => {
          const out: Record<string, any> = {};
          const type = input.home_pricing_type ?? current?.home_pricing_type ?? null;
          if (type) {
            out.home_pricing_type = type;
            if (type === 'by_distance') {
              const tiers = input.home_pricing_tiers?.length
                ? input.home_pricing_tiers
                : (current?.home_pricing_tiers || []).map((t: any) => ({ up_to_minutes: Number(t.up_to_minutes), fee: Number(t.fee) }));
              if (tiers.length) out.home_pricing_tiers = tiers;
            } else {
              const fee = input.home_fixed_fee ?? current?.home_fixed_fee;
              if (fee !== undefined && fee !== null) out.home_fixed_fee = fee;
            }
          }
          if (input.offers_home_services !== undefined) out.offers_home_services = bool01(input.offers_home_services);
          if (input.is_cloud !== undefined) {
            out.is_cloud = bool01(input.is_cloud);
            if (input.is_cloud) out.offers_home_services = '1';
          }
          return out;
        };
        switch (input.action) {
          case 'list':
            return pageOf(
              await api.getRaw('/branches', clean({ without_pagination: 'true', q: input.q, is_active: input.active_only ? '1' : undefined })),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/branches/${input.id}`);
          case 'create': {
            require(input, ['name', 'address', 'lat', 'long', 'official_hours'], 'create');
            const me = await api.get('/profile');
            return api.post(
              '/branches',
              {
                name: input.name,
                address: input.address,
                lat: String(input.lat),
                long: String(input.long),
                manager_id: me?.id,
                country_id: input.country_id ?? 1,
                region_id: input.region_id ?? 1,
                city_id: input.city_id ?? 1,
                official_hours: hourRows(input.official_hours),
                ...homeFields(null),
              },
              { multipart: true },
            );
          }
          case 'update': {
            require(input, ['id'], 'update');
            const [current, me] = await Promise.all([api.get(`/branches/${input.id}`), api.get('/profile')]);
            const payload: Record<string, any> = {
              name: input.name ?? current?.name,
              address: input.address ?? current?.address,
              lat: String(input.lat ?? current?.lat ?? ''),
              long: String(input.long ?? current?.long ?? ''),
              manager_id: me?.id,
              country_id: input.country_id ?? current?.country?.id ?? 1,
              region_id: input.region_id ?? current?.region?.id ?? 1,
              city_id: input.city_id ?? current?.city?.id ?? 1,
              official_hours: hourRows(input.official_hours?.length ? input.official_hours : current?.official_hours),
              ...homeFields(current),
            };
            const missing = ['name', 'address', 'lat', 'long'].filter((f) => !payload[f]);
            if (missing.length) {
              throw new Error(`This branch has no saved ${missing.join(', ')} — ask the vendor (places_search → places_location fills address, lat, long).`);
            }
            if (input.sync_employee_hours !== undefined) payload.sync_employee_hours = bool01(input.sync_employee_hours);
            if (input.existing_images !== undefined) {
              payload.manage_images = '1';
              if (input.existing_images.length) payload.existing_images = input.existing_images;
            }
            return api.putViaPost(`/branches/${input.id}`, payload, { multipart: true });
          }
          case 'activate':
          case 'deactivate':
          case 'clear_busy':
            require(input, ['id'], input.action);
            return api.post(`/branches/${input.id}/${input.action === 'clear_busy' ? 'clear-busy' : input.action}`);
          case 'set_busy':
            require(input, ['id', 'busy_from'], 'set_busy');
            return api.post(
              `/branches/${input.id}/set-busy`,
              clean({
                set_busy_at: saudiIso(input.busy_from),
                reset_busy_at: input.busy_until ? saudiIso(input.busy_until) : undefined,
                available_when_busy: bool01(input.available_when_busy),
              }),
              { multipart: true },
            );
          case 'places_search':
            require(input, ['q'], 'places_search');
            return api.get('/branches/places/autocomplete', { input: input.q });
          case 'places_details':
          case 'places_location':
            require(input, ['place_id'], input.action);
            return api.get(`/branches/places/${input.action === 'places_details' ? 'details' : 'location'}`, { place_id: input.place_id });
          case 'places_reverse':
          case 'places_reach':
            require(input, ['lat', 'lng'], input.action);
            return api.get(`/branches/places/${input.action === 'places_reverse' ? 'reverse' : 'reach'}`, { lat: input.lat, lng: input.lng });
          case 'set_google_place':
            require(input, ['id'], 'set_google_place');
            if (input.google_place_id === undefined) throw new Error('set_google_place needs google_place_id ("" unlinks).');
            return api.post(`/branches/${input.id}/google-place`, { google_place_id: input.google_place_id }, { multipart: true });
          case 'set_google_reviews':
            require(input, ['id'], 'set_google_reviews');
            if (input.show_google_reviews === undefined) throw new Error('set_google_reviews needs show_google_reviews.');
            return api.post(
              `/branches/${input.id}/google-reviews`,
              { show_google_reviews: bool01(input.show_google_reviews) },
              { multipart: true },
            );
          case 'google_stats':
            require(input, ['id'], 'google_stats');
            return api.get(`/branches/${input.id}/google-stats`);
          case 'google_stats_refresh': {
            require(input, ['id'], 'google_stats_refresh');
            const suffix = input.scope === 'employees' ? '/employees' : input.scope === 'competitors' ? '/competitors' : '';
            return api.post(`/branches/${input.id}/google-stats${suffix}/refresh`, undefined, { timeoutMs: 180_000 });
          }
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — section
    // ════════════════════════════════════════════════════════════════

    {
      name: 'section',
      description:
        'Service sections (قسم الشعر، قسم اللحية…).\nACTIONS:\n• list — optional q. Rows include their services (id + name). • get — id.\n• create — name_ar; optional description_ar, color (#RRGGBB).\n• update — id + any of name_ar, description_ar, color, sort (≥1).\n• activate / deactivate — id.\n• sort — sections [{id, sort, services?: [{id, sort}]}] (sort starts at 1). Listing a service under another section MOVES it there.\nDeleting a section is dashboard-only (it asks where its services go).',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'create', 'update', 'activate', 'deactivate', 'sort']),
        id: idLike.optional(),
        q: z.string().optional(),
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().min(2).optional(),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        sort: z.number().int().min(1).optional(),
        sections: z
          .array(
            z.object({
              id: idLike,
              sort: z.number().int().min(1),
              services: z.array(z.object({ id: idLike, sort: z.number().int().min(1) })).optional(),
            }),
          )
          .min(1)
          .optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return pageOf(
              await api.getRaw('/sections', clean({ without_pagination: 'true', q: input.q })),
              (row: any) => ({
                ...row,
                services: Array.isArray(row?.services) ? row.services.map((sv: any) => ({ id: sv.id, name: sv.name })) : row?.services,
              }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/sections/${input.id}`);
          case 'create':
            require(input, ['name_ar'], 'create');
            return api.post(
              '/sections',
              clean({ name_ar: input.name_ar, description_ar: input.description_ar, color: input.color }),
              { multipart: true },
            );
          case 'update': {
            require(input, ['id'], 'update');
            const payload = clean({ name_ar: input.name_ar, description_ar: input.description_ar, color: input.color, sort: input.sort });
            if (!Object.keys(payload).length) throw new Error('action="update" needs a field to change.');
            return api.putViaPost(`/sections/${input.id}`, payload, { multipart: true });
          }
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/sections/${input.id}/${input.action}`);
          case 'sort':
            require(input, ['sections'], 'sort');
            return api.post('/sections/sort', { sections: input.sections }, { multipart: true });
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — service
    // ════════════════════════════════════════════════════════════════

    {
      name: 'service',
      description:
        'Services.\nACTIONS:\n• list — filters: branch_id, section_id, active_only, q, page, per_page. • get — id (variants, home hours, suggested products).\n• create — name_ar, section_id, branch_id[], and either price + service_time (minutes) or sub_services (variants, each with its own price + service_time). Optional: description_ar, extra_time (buffer minutes), featured, product_ids (suggested products; feature `products`), is_home_service + home_service_fee + home_only + home_hours (the full list; it replaces the stored one).\n• update — id + any field; everything else is echoed, including variants with their ids. To remove a variant send sub_services without it (keep the others WITH ids); a variant pinned by an offer can\'t be removed. Turning is_home_service off clears home hours and home_only.\n• update_price — id + price (+ optional service_time); for a service with variants change the variant via update.\n• popular_templates — admin-curated names/descriptions for quick creation.\n• activate / deactivate — id.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'create', 'update', 'update_price', 'popular_templates', 'activate', 'deactivate']),
        id: idLike.optional(),
        branch_id: z.union([idLike, z.array(idLike)]).optional(),
        section_id: idLike.optional(),
        active_only: z.boolean().optional(),
        q: z.string().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().min(2).optional(),
        price: z.number().nonnegative().optional(),
        service_time: z.number().int().positive().optional(),
        extra_time: z.number().int().nonnegative().optional(),
        featured: z.boolean().optional(),
        sub_services: z.array(subServiceRowSchema).optional(),
        product_ids: z.array(idLike).optional(),
        is_home_service: z.boolean().optional(),
        home_only: z.boolean().optional(),
        home_service_fee: z.number().nonnegative().optional(),
        home_hours: z.array(hourRowSchema).optional(),
      }),
      handler: async (input) => {
        const asArray = (v: any) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v : [v]);
        const variantRows = (rows: any[]) =>
          rows
            .filter((r) => r?.name_ar && r.price != null && r.service_time != null)
            .map((r) => clean({
              id: r.id,
              name_ar: r.name_ar,
              name_en: r.name_en,
              price: r.price,
              service_time: r.service_time,
              extra_time: r.extra_time,
              sort: r.sort,
              is_active: r.is_active === undefined || r.is_active === null ? undefined : flag01(r.is_active),
            }));
        const update = async (id: any, patch: Record<string, any>) => {
          const current = await api.get(`/services/${id}`);
          const subs = patch.sub_services ?? current?.sub_services ?? [];
          if (patch.sub_services && !patch.sub_services.length && (current?.sub_services || []).length && (patch.price ?? current?.price) == null) {
            throw new Error('Removing all variants needs a price and service_time for the service itself.');
          }
          const payload: Record<string, any> = {
            name_ar: patch.name_ar ?? current?.name_ar ?? current?.name,
            section_id: patch.section_id ?? current?.section?.id ?? current?.section_id,
            branch_id: asArray(patch.branch_id) ?? (current?.branches || []).map((b: any) => b.id ?? b),
            featured: patch.featured !== undefined ? bool01(patch.featured) : flag01(current?.featured),
          };
          const description = patch.description_ar ?? current?.description_ar ?? current?.description;
          if (description && String(description).trim().length >= 2) payload.description_ar = description;
          if (subs.length) {
            payload.sub_services = variantRows(subs);
          } else {
            payload.price = patch.price ?? current?.price;
            payload.service_time = patch.service_time ?? current?.service_time;
            const extra = patch.extra_time ?? current?.extra_time;
            if (extra !== undefined && extra !== null) payload.extra_time = extra;
          }
          const home = patch.is_home_service ?? Number(current?.is_home_service) === 1;
          if (home) {
            payload.is_home_service = '1';
            payload.home_only = patch.home_only !== undefined ? bool01(patch.home_only) : flag01(current?.home_only);
            const fee = patch.home_service_fee ?? current?.home_service_fee;
            if (fee !== undefined && fee !== null) payload.home_service_fee = fee;
            const hours = hourRows(patch.home_hours ?? current?.home_hours);
            if (hours.length) payload.home_hours = hours;
          } else if (patch.is_home_service === false) {
            payload.is_home_service = '0';
          }
          if (patch.product_ids !== undefined) payload.product_ids = patch.product_ids;
          return api.putViaPost(`/services/${id}`, payload, { multipart: true });
        };
        switch (input.action) {
          case 'list': {
            const branchId = Array.isArray(input.branch_id) ? undefined : input.branch_id;
            if (input.section_id !== undefined) {
              const rows = rowsOf(await api.getRaw('/services', clean({ without_pagination: 'true', branch_id: branchId, q: input.q, is_active: input.active_only ? '1' : undefined })));
              return rows.filter((row: any) => String(row?.section?.id ?? row?.section_id) === String(input.section_id));
            }
            return pageOf(
              await api.getRaw('/services', clean({ branch_id: branchId, is_active: input.active_only ? '1' : undefined, q: input.q, page: input.page, per_page: input.per_page })),
            );
          }
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/services/${input.id}`);
          case 'popular_templates':
            return api.get('/popular-services');
          case 'create': {
            const variants = (input.sub_services?.length ?? 0) > 0;
            require(input, variants ? ['name_ar', 'section_id', 'branch_id'] : ['name_ar', 'section_id', 'branch_id', 'price', 'service_time'], 'create');
            const payload: Record<string, any> = clean({
              name_ar: input.name_ar,
              description_ar: input.description_ar,
              section_id: input.section_id,
              branch_id: asArray(input.branch_id),
              price: variants ? undefined : input.price,
              service_time: variants ? undefined : input.service_time,
              extra_time: input.extra_time,
              featured: bool01(input.featured),
              sub_services: variants ? variantRows(input.sub_services!) : undefined,
              product_ids: input.product_ids?.length ? input.product_ids : undefined,
            });
            if (input.is_home_service) {
              payload.is_home_service = '1';
              if (input.home_only !== undefined) payload.home_only = bool01(input.home_only);
              if (input.home_service_fee !== undefined) payload.home_service_fee = input.home_service_fee;
              const hours = hourRows(input.home_hours);
              if (hours.length) payload.home_hours = hours;
            }
            return api.post('/services', payload, { multipart: true });
          }
          case 'update': {
            require(input, ['id'], 'update');
            const { action, id, ...patch } = input;
            return update(id, patch);
          }
          case 'update_price': {
            require(input, ['id', 'price'], 'update_price');
            const current = await api.get(`/services/${input.id}`);
            if ((current?.sub_services || []).length) {
              throw new Error('This service has variants — change the variant price with action="update" and the full sub_services list (keep every id).');
            }
            return update(input.id, { price: input.price, service_time: input.service_time });
          }
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/services/${input.id}/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — offer
    // ════════════════════════════════════════════════════════════════

    {
      name: 'offer',
      description:
        'Offers (عروض): several services sold together.\nACTIONS:\n• list — optional branch_id, active_only, q, page, per_page. • get — id (services with variants, service_pins).\n• create — name_ar, description_ar, section_id, service_ids, price_type: service (no discount) / free / discount (+ discount_percentage) / special (+ offer_price). service_price = sum of the included services (computed when omitted). Optional sub_service_ids (pin one variant per service; leave a service unpinned to let the customer choose), home delivery fields like services (home_hours = the full list).\n• update — id + any field; the rest is echoed. sub_service_ids changes only the services you pass ("" unpins one).\n• sort — items [{id, sort ≥1}].\n• activate / deactivate — id.\nAvailability per branch follows the services inside the offer. Confirm the price math with the vendor.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'create', 'update', 'sort', 'activate', 'deactivate']),
        id: idLike.optional(),
        branch_id: idLike.optional(),
        active_only: z.boolean().optional(),
        q: z.string().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().min(2).optional(),
        section_id: idLike.optional(),
        service_ids: z.array(idLike).min(1).optional(),
        sub_service_ids: idKeyedMap.optional(),
        price_type: z.enum(['service', 'free', 'discount', 'special']).optional(),
        service_price: z.number().nonnegative().optional(),
        discount_percentage: z.number().min(0).max(100).optional(),
        offer_price: z.number().nonnegative().optional(),
        sort: z.number().int().min(1).optional(),
        items: z.array(z.object({ id: idLike, sort: z.number().int().min(1) })).min(1).optional(),
        is_home_service: z.boolean().optional(),
        home_only: z.boolean().optional(),
        home_service_fee: z.number().nonnegative().optional(),
        home_hours: z.array(hourRowSchema).optional(),
      }),
      handler: async (input) => {
        const pricing = (type: string, servicePrice: number, discount: number, offerPrice: number) => {
          switch (type) {
            case 'free':
              return { discount_percentage: 100, offer_price: 0 };
            case 'discount':
              return { discount_percentage: discount, offer_price: Math.round(servicePrice * (100 - discount)) / 100 };
            case 'special':
              return {
                discount_percentage: servicePrice > 0 ? Math.round(((servicePrice - offerPrice) / servicePrice) * 10000) / 100 : 0,
                offer_price: offerPrice,
              };
            default:
              return { discount_percentage: 0, offer_price: servicePrice };
          }
        };
        const sumPrices = async (ids: any[], pins: Record<string, any>) => {
          let total = 0;
          for (const id of ids) {
            const svc = await api.get(`/services/${id}`);
            const pinned = pins[String(id)];
            const variants: any[] = svc?.sub_services || [];
            const variant = pinned != null ? variants.find((v) => String(v.id) === String(pinned)) : null;
            const price = variant?.price ?? svc?.price ?? (variants.length ? Math.min(...variants.map((v) => Number(v.price))) : 0);
            total += Number(price) || 0;
          }
          return total;
        };
        const homePayload = (current: any) => {
          const out: Record<string, any> = {};
          const home = input.is_home_service ?? Boolean(current && (current.is_home_service === true || Number(current.is_home_service) === 1));
          if (home) {
            out.is_home_service = '1';
            out.home_only = input.home_only !== undefined ? bool01(input.home_only) : flag01(current?.home_only);
            const fee = input.home_service_fee ?? current?.home_service_fee;
            if (fee !== undefined && fee !== null) out.home_service_fee = fee;
            const hours = hourRows(input.home_hours ?? current?.home_hours);
            if (hours.length) out.home_hours = hours;
          } else if (input.is_home_service === false) {
            out.is_home_service = '0';
          }
          return out;
        };
        switch (input.action) {
          case 'list':
            return pageOf(
              await api.getRaw('/offers', clean({ branch_id: input.branch_id, is_active: input.active_only ? '1' : undefined, q: input.q, page: input.page, per_page: input.per_page })),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/offers/${input.id}`);
          case 'create': {
            require(input, ['name_ar', 'description_ar', 'section_id', 'service_ids', 'price_type'], 'create');
            const pins = Object.fromEntries(Object.entries(input.sub_service_ids ?? {}).filter(([, v]) => v !== null && v !== ''));
            const servicePrice = input.service_price ?? (await sumPrices(input.service_ids!, pins));
            return api.post(
              '/offers',
              clean({
                name_ar: input.name_ar,
                description_ar: input.description_ar,
                section_id: input.section_id,
                service_id: input.service_ids,
                sub_service_ids: Object.keys(pins).length ? pins : undefined,
                price_type: input.price_type,
                service_price: servicePrice,
                ...pricing(input.price_type!, servicePrice, input.discount_percentage ?? 0, input.offer_price ?? 0),
                sort: input.sort,
                ...homePayload(null),
              }),
              { multipart: true },
            );
          }
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/offers/${input.id}`);
            const serviceIds = input.service_ids?.length ? input.service_ids : (current?.services || []).map((sv: any) => sv.id);
            const pins = Object.fromEntries(
              Object.entries({ ...(current?.service_pins || {}), ...(input.sub_service_ids || {}) }).filter(
                ([sid, v]) => v !== null && v !== undefined && v !== '' && serviceIds.map(String).includes(String(sid)),
              ),
            );
            const type = input.price_type ?? current?.price_type ?? 'service';
            const servicePrice = input.service_price
              ?? (input.service_ids?.length ? await sumPrices(serviceIds, pins) : Number(current?.service_price ?? 0));
            const payload: Record<string, any> = {
              name_ar: input.name_ar ?? current?.name_ar ?? current?.name,
              description_ar: input.description_ar ?? current?.description_ar ?? current?.description,
              section_id: input.section_id ?? current?.section?.id ?? current?.section_id,
              service_id: serviceIds,
              price_type: type,
              service_price: servicePrice,
              ...pricing(type, servicePrice, input.discount_percentage ?? Number(current?.discount_percentage ?? 0), input.offer_price ?? Number(current?.offer_price ?? 0)),
              ...homePayload(current),
            };
            if (Object.keys(pins).length) payload.sub_service_ids = pins;
            if (input.sort !== undefined) payload.sort = input.sort;
            return api.putViaPost(`/offers/${input.id}`, payload, { multipart: true });
          }
          case 'sort':
            require(input, ['items'], 'sort');
            return api.post('/offers/sort', { items: input.items }, { multipart: true });
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/offers/${input.id}/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — employee
    // ════════════════════════════════════════════════════════════════

    {
      name: 'employee',
      description:
        'Employees (specialists).\nACTIONS:\n• list — filters: branch_id, q, active_only, exclude_busy, page, per_page. • get — id (hours, breaks, services, branches, invitation state).\n• create — first_name, email, phone, branch_id (one or several), role_id (role action="list"), official_hours [{day, start_time, end_time}] (the full week; on update it replaces the stored hours). The person gets an email invitation to join (no password is set; they sign in by email code after accepting). Optional: last_name, service_ids, break_hours, job_title, bio, salary, commission_type (none/fixed/percentage) + commission, commission_calculation_method (gross/net), start_date, end_date, is_manager (receives the branch\'s booking alerts and daily summary — not a permission).\n• update — id + any field; required fields, services, branches and commission are echoed. Changing email sends a new invitation.\n• resend_invitation — id (pending invitations only).\n• activate / deactivate — id (deactivated staff still count toward the plan limit).\n• set_busy — id + busy_from (+ optional busy_until) takes them off new bookings; available_when_busy=false also hides them. • clear_busy — id.\nConfirm every field with the vendor.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'create', 'update', 'resend_invitation', 'activate', 'deactivate', 'set_busy', 'clear_busy']),
        id: idLike.optional(),
        branch_id: z.union([idLike, z.array(idLike)]).optional(),
        q: z.string().optional(),
        active_only: z.boolean().optional(),
        exclude_busy: z.boolean().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        first_name: z.string().min(2).optional(),
        last_name: z.string().min(2).optional(),
        email: z.string().email().optional(),
        phone: z.string().min(9).optional(),
        role_id: idLike.optional(),
        service_ids: z.array(idLike).optional(),
        official_hours: z.array(hourRowSchema).optional(),
        break_hours: z
          .array(z.object({ day: dayEnum, start_time: z.string(), end_time: z.string().describe('HH:MM, or 24:00 for end of day') }))
          .optional(),
        job_title: z.string().min(2).optional(),
        bio: z.string().min(2).max(1000).optional(),
        salary: z.number().nonnegative().optional(),
        commission_type: z.enum(['none', 'fixed', 'percentage']).optional(),
        commission: z.number().nonnegative().optional(),
        commission_calculation_method: z.enum(['gross', 'net']).optional(),
        start_date: z.string().regex(datePattern).optional(),
        end_date: z.string().regex(datePattern).optional(),
        is_manager: z.boolean().optional(),
        busy_from: localDateTime.optional(),
        busy_until: localDateTime.optional(),
        available_when_busy: z.boolean().optional(),
      }),
      handler: async (input) => {
        const asArray = (v: any) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v : [v]);
        const breaks = (rows: any) =>
          (Array.isArray(rows) ? rows : [])
            .filter((h: any) => h?.day && h?.start_time && h?.end_time)
            .map((h: any) => ({ day: h.day, start_time: hhmm(h.start_time), end_time: String(h.end_time).startsWith('24') ? '24:00' : hhmm(h.end_time) }));
        const optional = (payload: Record<string, any>) => {
          for (const key of ['last_name', 'job_title', 'bio', 'salary', 'commission_calculation_method', 'start_date', 'end_date'] as const) {
            if (input[key] !== undefined) payload[key] = input[key];
          }
          if (input.is_manager !== undefined) payload.is_manager = bool01(input.is_manager);
          return payload;
        };
        switch (input.action) {
          case 'list':
            return pageOf(
              await api.getRaw(
                '/employees',
                clean({
                  branch_id: Array.isArray(input.branch_id) ? undefined : input.branch_id,
                  q: input.q,
                  is_active: input.active_only ? '1' : undefined,
                  exclude_busy: input.exclude_busy ? '1' : undefined,
                  page: input.page,
                  per_page: input.per_page,
                }),
              ),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/employees/${input.id}`);
          case 'create': {
            require(input, ['first_name', 'email', 'phone', 'branch_id', 'role_id', 'official_hours'], 'create');
            const type = input.commission_type ?? 'none';
            return api.post(
              '/employees',
              optional(clean({
                first_name: input.first_name,
                email: input.email,
                phone: input.phone,
                branch_id: asArray(input.branch_id),
                role_id: input.role_id,
                official_hours: hourRows(input.official_hours),
                break_hours: input.break_hours?.length ? breaks(input.break_hours) : undefined,
                service_id: input.service_ids?.length ? input.service_ids : undefined,
                commission_type: type,
                commission: type === 'none' ? undefined : input.commission ?? 0,
              })),
              { multipart: true },
            );
          }
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/employees/${input.id}`);
            const type = input.commission_type ?? current?.commission_type ?? 'none';
            const payload: Record<string, any> = {
              first_name: input.first_name ?? current?.first_name,
              email: input.email ?? current?.email,
              phone: input.phone ?? current?.phone,
              branch_id: asArray(input.branch_id) ?? (current?.branches || []).map((b: any) => b.id),
              role_id: input.role_id ?? current?.role?.id,
              official_hours: hourRows(input.official_hours?.length ? input.official_hours : current?.working_hours),
              commission_type: type,
            };
            if (type !== 'none') payload.commission = input.commission ?? Number(current?.commission ?? 0);
            const serviceIds = input.service_ids ?? (current?.services || []).map((sv: any) => sv.id);
            if (serviceIds.length) payload.service_id = serviceIds;
            const breakRows = breaks(input.break_hours?.length ? input.break_hours : current?.break_hours);
            if (breakRows.length) payload.break_hours = breakRows;
            const missing = ['first_name', 'email', 'phone', 'role_id'].filter((f) => !payload[f]);
            if (missing.length || !payload.branch_id?.length || !payload.official_hours.length) {
              throw new Error(`Employee update is missing: ${[...missing, ...(payload.branch_id?.length ? [] : ['branch_id']), ...(payload.official_hours.length ? [] : ['official_hours'])].join(', ')}.`);
            }
            return api.putViaPost(`/employees/${input.id}`, optional(payload), { multipart: true });
          }
          case 'resend_invitation':
            require(input, ['id'], 'resend_invitation');
            return api.post(`/employees/${input.id}/invitation`);
          case 'activate':
          case 'deactivate':
          case 'clear_busy':
            require(input, ['id'], input.action);
            return api.post(`/employees/${input.id}/${input.action === 'clear_busy' ? 'clear-busy' : input.action}`);
          case 'set_busy':
            require(input, ['id', 'busy_from'], 'set_busy');
            return api.post(
              `/employees/${input.id}/set-busy`,
              clean({
                set_busy_at: saudiIso(input.busy_from),
                reset_busy_at: input.busy_until ? saudiIso(input.busy_until) : undefined,
                available_when_busy: bool01(input.available_when_busy),
              }),
              { multipart: true },
            );
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — employee_portfolio
    // ════════════════════════════════════════════════════════════════

    {
      name: 'employee_portfolio',
      description:
        'An employee\'s work gallery (uploads are dashboard-only).\nACTIONS:\n• sort — employee_id + items [{id, sort}] (lower = first).\n• activate / deactivate — employee_id + image_id (show/hide on the customer page).',
      inputSchema: z.object({
        action: z.enum(['sort', 'activate', 'deactivate']),
        employee_id: idLike,
        image_id: idLike.optional(),
        items: z.array(z.object({ id: idLike, sort: z.number().int().min(0) })).min(1).optional(),
      }),
      handler: async (input) => {
        if (input.action === 'sort') {
          require(input, ['items'], 'sort');
          return api.post(`/employees/${input.employee_id}/portfolio/sort`, { items: input.items }, { multipart: true });
        }
        require(input, ['image_id'], input.action);
        return api.post(`/employees/${input.employee_id}/portfolio/${input.image_id}/${input.action}`);
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — customer
    // ════════════════════════════════════════════════════════════════

    {
      name: 'customer',
      description:
        'Customers.\nACTIONS:\n• list — q (name / phone / email), branch_id, page, per_page. By default only customers who booked with this vendor; all_records=true searches every registered customer (use it to find someone by phone before creating).\n• get — id.\n• create — first_name (≥2), phone (Saudi mobile, 05…); optional last_name, email, referral_channel (google/fresha/instagram/now_link/walk_in). A phone or email that already belongs to a customer is rejected — look them up with list all_records=true instead.\nUse the returned id as booking customer_id.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'create']),
        id: idLike.optional(),
        q: z.string().optional(),
        branch_id: idLike.optional(),
        all_records: z.boolean().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        first_name: z.string().min(2).optional(),
        last_name: z.string().min(2).optional(),
        phone: z.string().optional(),
        email: z.string().email().optional(),
        referral_channel: z.enum(['google', 'fresha', 'instagram', 'now_link', 'walk_in']).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return pageOf(
              await api.getRaw(
                '/customers',
                clean({
                  q: input.q,
                  branch_id: input.branch_id,
                  all_records: input.all_records ? 'true' : undefined,
                  page: input.page,
                  per_page: input.per_page,
                }),
              ),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/customers/${input.id}`, { all_records: 'true' });
          case 'create':
            require(input, ['first_name', 'phone'], 'create');
            return api.post(
              '/customers',
              clean({
                first_name: input.first_name,
                last_name: input.last_name,
                phone: input.phone,
                email: input.email,
                referral_channel: input.referral_channel,
              }),
            );
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — review
    // ════════════════════════════════════════════════════════════════

    {
      name: 'review',
      description:
        'Customer reviews (read-only; moderation is admin-side).\nACTIONS:\n• list — filters: branch_id, employee_id, rating (1-5), from / to (YYYY-MM-DD, inclusive, by appointment date), page, per_page. Returns rows (with per-employee ratings) and a summary {average, count, breakdown} — the summary ignores the rating filter.\n• get — id.',
      inputSchema: z.object({
        action: z.enum(['list', 'get']),
        id: idLike.optional(),
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
        rating: z.number().int().min(1).max(5).optional(),
        from: z.string().regex(datePattern).optional(),
        to: z.string().regex(datePattern).optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        if (input.action === 'get') {
          require(input, ['id'], 'get');
          return api.get(`/reviews/${input.id}`);
        }
        return pageOf(
          await api.getRaw(
            '/reviews',
            clean({
              branch_id: input.branch_id,
              employee_id: input.employee_id,
              rating: input.rating,
              from: input.from,
              to: input.to ? `${input.to} 23:59:59` : undefined,
              page: input.page,
              per_page: input.per_page,
            }),
          ),
        );
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — invoice
    // ════════════════════════════════════════════════════════════════

    {
      name: 'invoice',
      description:
        'Invoices (read-only). Every completed booking and bundle sale gets one; only ZATCA-active vendors send them to ZATCA.\nACTIONS:\n• list — filters: type (customer = to customers, vendor = platform invoices to the vendor), booking_id, q (exact invoice number), document_type (invoice/credit_note/debit_note; default invoice), page, per_page.\n• get — id; includes notes[] (credit/debit notes, newest first).\nFields: total/vat are the original issued amounts; net_total/net_vat include credit/debit notes — show net_total when present. zatca_status: pending/reported/cleared/rejected/failed; skipped = not sent to ZATCA.',
      inputSchema: z.object({
        action: z.enum(['list', 'get']),
        id: idLike.optional(),
        type: z.enum(['customer', 'vendor']).optional(),
        booking_id: idLike.optional(),
        q: z.string().optional(),
        document_type: z.enum(['invoice', 'credit_note', 'debit_note']).optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return pageOf(
              await api.getRaw(
                '/invoices',
                clean({
                  type: input.type,
                  booking_id: input.booking_id,
                  q: input.q,
                  document_type: input.document_type,
                  page: input.page,
                  per_page: input.per_page,
                }),
              ),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/invoices/${input.id}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — cancellation_reason
    // ════════════════════════════════════════════════════════════════

    {
      name: 'cancellation_reason',
      description:
        'Cancellation reasons customers pick from (shown together with the platform defaults).\nACTIONS:\n• list — q, page, per_page (the first visit seeds defaults unless skip_seed). • get — id.\n• create — reason_ar (2-500); optional reason_en, sort (0-127).\n• update — id + any of reason_ar, reason_en, sort.\n• activate / deactivate — id.\n• sort — items [{id, sort}].',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'create', 'update', 'activate', 'deactivate', 'sort']),
        id: idLike.optional(),
        reason_ar: z.string().min(2).max(500).optional(),
        reason_en: z.string().min(2).max(500).optional(),
        sort: z.number().int().min(0).max(127).optional(),
        q: z.string().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        skip_seed: z.boolean().optional(),
        items: z.array(z.object({ id: idLike, sort: z.number().int().min(0).max(127) })).min(1).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return pageOf(
              await api.getRaw(
                '/cancellation-reasons',
                clean({ q: input.q, page: input.page, per_page: input.per_page, skip_seed: input.skip_seed ? '1' : undefined }),
              ),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/cancellation-reasons/${input.id}`);
          case 'create':
            require(input, ['reason_ar'], 'create');
            return api.post(
              '/cancellation-reasons',
              clean({ reason_ar: input.reason_ar, reason_en: input.reason_en, sort: input.sort }),
              { multipart: true },
            );
          case 'update': {
            require(input, ['id'], 'update');
            const current = input.reason_ar ? null : await api.get(`/cancellation-reasons/${input.id}`);
            return api.putViaPost(
              `/cancellation-reasons/${input.id}`,
              clean({ reason_ar: input.reason_ar ?? current?.reason_ar, reason_en: input.reason_en, sort: input.sort }),
              { multipart: true },
            );
          }
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/cancellation-reasons/${input.id}/${input.action}`);
          case 'sort':
            require(input, ['items'], 'sort');
            return api.post('/cancellation-reasons/sort', { items: input.items }, { multipart: true });
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — product
    // ════════════════════════════════════════════════════════════════

    {
      name: 'product',
      description:
        'Retail products (شامبو، زيت لحية…): priced, no duration. Sold at the counter alone (booking action="create" with product_ids only) or added to a booking. Needs the package feature `products`.\nACTIONS:\n• list — filters: q, branch_id, active_only, page, per_page. Rows carry suggested_for (services it is suggested with).\n• get — id (includes service_ids, branch_ids).\n• create — name_ar, price. Optional: description_ar, branch_id[] (default: all active branches), commission_type (none/fixed/percentage) + commission, service_ids (suggest the product when these services are booked).\n• update — id + any field; the rest is echoed. service_ids replaces the list ([] clears it).\n• templates — admin-curated product names/descriptions for quick creation.\n• activate / deactivate — id.\nImages can only be managed in the dashboard.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'create', 'update', 'templates', 'activate', 'deactivate']),
        id: idLike.optional(),
        q: z.string().optional(),
        active_only: z.boolean().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().optional(),
        price: z.number().nonnegative().optional(),
        branch_id: z.union([idLike, z.array(idLike)]).optional(),
        commission_type: z.enum(['none', 'fixed', 'percentage']).optional(),
        commission: z.number().nonnegative().optional(),
        service_ids: z.array(idLike).optional(),
      }),
      handler: async (input) => {
        const asArray = (v: any) => (v === undefined || v === null ? undefined : Array.isArray(v) ? v : [v]);
        switch (input.action) {
          case 'list':
            return pageOf(
              await api.getRaw(
                '/products',
                clean({
                  q: input.q,
                  branch_id: Array.isArray(input.branch_id) ? undefined : input.branch_id,
                  is_active: input.active_only ? '1' : undefined,
                  page: input.page,
                  per_page: input.per_page,
                }),
              ),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/products/${input.id}`);
          case 'templates':
            return api.get('/default-products');
          case 'create': {
            require(input, ['name_ar', 'price'], 'create');
            let branches = asArray(input.branch_id);
            if (!branches?.length) {
              branches = rowsOf(await api.getRaw('/branches', { without_pagination: 'true' })).map((b: any) => b.id);
            }
            const type = input.commission_type ?? 'none';
            return api.post(
              '/products',
              clean({
                name_ar: input.name_ar,
                description_ar: input.description_ar?.trim() || undefined,
                price: input.price,
                branch_id: branches,
                commission_type: type,
                commission: type === 'none' ? 0 : input.commission ?? 0,
                service_ids: input.service_ids?.length ? input.service_ids : undefined,
              }),
              { multipart: true },
            );
          }
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/products/${input.id}`);
            const type = input.commission_type ?? current?.commission_type ?? 'none';
            const payload: Record<string, any> = {
              name_ar: input.name_ar ?? current?.name,
              price: input.price ?? Number(current?.price ?? 0),
              branch_id: asArray(input.branch_id) ?? current?.branch_ids ?? (current?.branches || []).map((b: any) => b.id),
              commission_type: type,
              commission: type === 'none' ? 0 : input.commission ?? Number(current?.commission ?? 0),
            };
            if (input.description_ar !== undefined) payload.description_ar = input.description_ar.trim();
            if (input.service_ids !== undefined) payload.service_ids = input.service_ids.length ? input.service_ids : '';
            return api.putViaPost(`/products/${input.id}`, payload, { multipart: true });
          }
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/products/${input.id}/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — bundle
    // ════════════════════════════════════════════════════════════════

    {
      name: 'bundle',
      description:
        'Prepaid bundles (باقات): the customer pays once and uses the included services/offers over several visits; later bookings of that customer consume them automatically.\nACTIONS:\n• list — filters: q, branch_id, active_only, page, per_page. • get — id (items, branches, terms).\n• create / update — name_ar, terms_ar, price, usage_limit (visits), period_days (validity after purchase), items [{type: service|offer, id}], selection_mode: all (every item each visit) or choose_n (customer picks choose_count items per visit, ranked by selection_priority: max_discount / min_discount / customer_selection). Optional: description_ar, branch_ids (omit or [] = all branches), start_date / end_date (sale window, YYYY-MM-DD), restore_usage_on_refund, includes_home_service_fee. update echoes what you omit, except selection_priority, which the backend never returns — ask the vendor when the bundle is choose_n.\n• sort — items [{id, sort}].\n• sell — cash sale to a customer: id + customer_id (+ branch_id for branch-limited bundles). Records the sale and its invoice.\n• sell_online — id + customer_id → pay_url (valid 20 min) the customer pays on their phone.\n• subscribers — id; filter status (pending/active/declined/refunded). • usage — id; history of visits that used it. • summary — id + period (day/week/month/3months/6months/9months/year): sold, revenue, commission, active/expired holders, redemptions.\n• activate / deactivate — id.\nRefunds are done from the dashboard.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'update',
          'sort',
          'sell',
          'sell_online',
          'subscribers',
          'usage',
          'summary',
          'activate',
          'deactivate',
        ]),
        id: idLike.optional(),
        q: z.string().optional(),
        branch_id: idLike.optional(),
        active_only: z.boolean().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().optional(),
        terms_ar: z.string().min(2).optional(),
        price: z.number().nonnegative().optional(),
        usage_limit: z.number().int().min(1).optional(),
        period_days: z.number().int().min(1).optional(),
        selection_mode: z.enum(['all', 'choose_n']).optional(),
        choose_count: z.number().int().min(1).optional(),
        selection_priority: z.enum(['max_discount', 'min_discount', 'customer_selection']).optional(),
        items: z
          .array(z.object({ type: z.enum(['service', 'offer']).optional(), id: idLike, sort: z.number().int().optional() }))
          .optional()
          .describe('create/update: [{type, id}] services/offers in the bundle. sort: [{id, sort}] bundle order.'),
        branch_ids: z.array(idLike).optional(),
        start_date: z.string().regex(datePattern).optional(),
        end_date: z.string().regex(datePattern).optional(),
        restore_usage_on_refund: z.boolean().optional(),
        includes_home_service_fee: z.boolean().optional(),
        customer_id: idLike.optional(),
        notes: z.string().max(500).optional(),
        status: z.enum(['pending', 'active', 'declined', 'refunded']).optional(),
        period: z.enum(['day', 'week', 'month', '3months', '6months', '9months', 'year']).optional(),
      }),
      handler: async (input) => {
        const vendorId = async () => (await api.get('/profile'))?.model_id;
        const writeItems = (rows: any[]) =>
          rows.map((row, index) => ({
            type: row.type ?? 'service',
            [(row.type ?? 'service') === 'offer' ? 'offer_id' : 'service_id']: row.id,
            sort: row.sort ?? index,
          }));
        switch (input.action) {
          case 'list':
            return pageOf(
              await api.getRaw(
                '/bundles',
                clean({
                  q: input.q,
                  branch_id: input.branch_id,
                  is_active: input.active_only ? '1' : undefined,
                  with_count: ['items'],
                  page: input.page,
                  per_page: input.per_page,
                }),
              ),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/bundles/${input.id}`);
          case 'create':
          case 'update': {
            const current = input.action === 'update' ? (require(input, ['id'], 'update'), await api.get(`/bundles/${input.id}`)) : null;
            const currentItems = (current?.items || [])
              .map((it: any) => ({ type: it.type, id: it.type === 'offer' ? it.offer?.id : it.service?.id }))
              .filter((it: any) => it.id);
            const mode = input.selection_mode ?? current?.selection_mode ?? 'all';
            const payload: Record<string, any> = {
              vendor_id: await vendorId(),
              name_ar: input.name_ar ?? current?.name,
              description_ar: (input.description_ar ?? current?.description ?? '').trim(),
              terms_ar: input.terms_ar ?? current?.terms,
              price: input.price ?? (current ? Number(current.price) : undefined),
              usage_limit: input.usage_limit ?? current?.usage_limit,
              period_days: input.period_days ?? current?.period_days,
              selection_mode: mode,
              items: writeItems(input.items ?? currentItems),
              restore_usage_on_refund: bool01(input.restore_usage_on_refund ?? current?.restore_usage_on_refund ?? false),
              includes_home_service_fee: bool01(input.includes_home_service_fee ?? current?.includes_home_service_fee ?? false),
            };
            if (mode === 'choose_n') {
              const priority = input.selection_priority ?? (input.action === 'create' ? 'min_discount' : undefined);
              if (!priority) {
                throw new Error('This is a choose_n bundle: ask the vendor for selection_priority (max_discount / min_discount / customer_selection) — the backend does not return the stored value.');
              }
              payload.choose_count = input.choose_count ?? current?.choose_count;
              payload.selection_priority = priority;
            } else {
              payload.choose_count = '';
              payload.selection_priority = '';
            }
            const branchIds = input.branch_ids ?? (current ? (current.branches || []).map((b: any) => b.id) : []);
            payload.all_branches = branchIds.length ? '0' : '1';
            if (branchIds.length) payload.branch_id = branchIds;
            if (input.start_date) payload.start_date = input.start_date;
            if (input.end_date) payload.end_date = input.end_date;
            const missing = ['name_ar', 'terms_ar', 'price', 'usage_limit', 'period_days'].filter(
              (f) => payload[f] === undefined || payload[f] === null || payload[f] === '',
            );
            if (missing.length || !payload.items.length) {
              throw new Error(`Bundle needs: ${[...missing, ...(payload.items.length ? [] : ['items'])].join(', ')}.`);
            }
            return input.action === 'create'
              ? api.post('/bundles', payload, { multipart: true })
              : api.putViaPost(`/bundles/${input.id}`, payload, { multipart: true });
          }
          case 'sort':
            require(input, ['items'], 'sort');
            return api.post(
              '/bundles/sort',
              { items: input.items.map((it: any, index: number) => ({ id: it.id, sort: it.sort ?? index + 1 })) },
              { multipart: true },
            );
          case 'sell':
          case 'sell_online':
            require(input, ['id', 'customer_id'], input.action);
            return api.post(
              `/bundles/${input.id}/${input.action === 'sell' ? 'sell' : 'sell-online'}`,
              clean({ customer_id: input.customer_id, branch_id: input.branch_id, notes: input.notes }),
              { multipart: true },
            );
          case 'subscribers':
            require(input, ['id'], 'subscribers');
            return pageOf(
              await api.getRaw(`/bundles/${input.id}/subscribers`, clean({ status: input.status, page: input.page, per_page: input.per_page })),
            );
          case 'usage':
            require(input, ['id'], 'usage');
            return pageOf(await api.getRaw(`/bundles/${input.id}/usage-history`, clean({ page: input.page, per_page: input.per_page })));
          case 'summary':
            require(input, ['id'], 'summary');
            return api.get(`/bundles/${input.id}/summary`, clean({ period: input.period }));
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/bundles/${input.id}/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — promo_code
    // ════════════════════════════════════════════════════════════════

    {
      name: 'promo_code',
      description:
        'Promo codes created by this account.\nACTIONS:\n• list — page, per_page. • get — id.\n• create — discount_type (percentage 0-100 / fixed SAR), value, start_date, end_date (after start), uses (≥1). Optional code (letters/digits, ≥5; generated when omitted).\n• update — id + code + any other field. The API always issues a code on edit, so pass the code to use from now on (a NEW unique one — the current code is rejected as taken). Tell the vendor the old code stops working. To keep a code unchanged, don\'t edit it — deactivate and create another instead.\n• activate / deactivate — id.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'create', 'update', 'activate', 'deactivate']),
        id: idLike.optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        code: z.string().min(5).regex(/^[A-Za-z0-9]+$/, 'Letters and digits only.').optional(),
        discount_type: z.enum(['percentage', 'fixed']).optional(),
        value: z.number().nonnegative().optional(),
        start_date: z.string().regex(datePattern).optional(),
        end_date: z.string().regex(datePattern).optional(),
        uses: z.number().int().min(1).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return pageOf(await api.getRaw('/promo-codes', clean({ page: input.page, per_page: input.per_page })));
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/promo-codes/${input.id}`);
          case 'create':
            require(input, ['discount_type', 'value', 'start_date', 'end_date', 'uses'], 'create');
            return api.post(
              '/promo-codes',
              clean({
                code: input.code,
                discount_type: input.discount_type,
                value: input.value,
                start_date: input.start_date,
                end_date: input.end_date,
                uses: input.uses,
              }),
              { multipart: true },
            );
          case 'update': {
            require(input, ['id', 'code'], 'update');
            const current = await api.get(`/promo-codes/${input.id}`);
            const day = (v: any) => (typeof v === 'string' ? v.slice(0, 10) : v);
            return api.putViaPost(
              `/promo-codes/${input.id}`,
              clean({
                code: input.code,
                discount_type: input.discount_type ?? current?.discount_type,
                value: input.value ?? current?.value,
                start_date: input.start_date ?? day(current?.start_date),
                end_date: input.end_date ?? day(current?.end_date),
                uses: input.uses ?? current?.uses,
              }),
              { multipart: true },
            );
          }
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/promo-codes/${input.id}/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — role
    // ════════════════════════════════════════════════════════════════

    {
      name: 'role',
      description:
        'Staff roles (assigned with employee role_id).\nACTIONS:\n• list — page, per_page. • get — id → name + permissions as names.\n• create — name + permissions: names like "bookings.list" (see list_permissions).\n• update — id + name and/or permissions (the full new list; omitted keeps the current one).\n• activate / deactivate — id (a role in use can\'t be deactivated).\nKeep roles minimal: don\'t grant roles.*, settings.*, zatca.*, wallets.list or reports.* unless the vendor asks.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'create', 'update', 'activate', 'deactivate']),
        id: idLike.optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        name: z.string().min(2).optional(),
        permissions: z.array(z.string()).optional(),
      }),
      handler: async (input) => {
        const idsFor = async (names: string[]) => {
          const { byName } = await permissionCatalogue(api);
          const unknown = names.filter((n) => !byName.has(n.trim().toLowerCase()));
          if (unknown.length) throw new Error(`Unknown permissions: ${unknown.join(', ')} — call list_permissions.`);
          return names.map((n) => byName.get(n.trim().toLowerCase())!);
        };
        const selectedIds = (role: any) =>
          Object.values<any>(role?.permissions || {}).flat().filter((p: any) => p?.selected).map((p: any) => Number(p.id));
        switch (input.action) {
          case 'list':
            return pageOf(await api.getRaw('/roles', clean({ page: input.page, per_page: input.per_page })));
          case 'get': {
            require(input, ['id'], 'get');
            const [role, { byId }] = await Promise.all([api.get(`/roles/${input.id}`), permissionCatalogue(api)]);
            return { ...role, permissions: selectedIds(role).map((id) => byId.get(id) ?? id) };
          }
          case 'create':
            require(input, ['name', 'permissions'], 'create');
            return api.post(
              '/roles',
              { name: input.name, permissions_ids: await idsFor(input.permissions!) },
              { multipart: true },
            );
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/roles/${input.id}`);
            const ids = input.permissions ? await idsFor(input.permissions) : selectedIds(current);
            if (!ids.length) throw new Error('A role needs at least one permission.');
            return api.putViaPost(
              `/roles/${input.id}`,
              { name: input.name ?? current?.name, permissions_ids: ids },
              { multipart: true },
            );
          }
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/roles/${input.id}/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — reminder
    // ════════════════════════════════════════════════════════════════

    {
      name: 'reminder',
      description:
        'Customer notification templates: type "reminder" (sent `duration` minutes before the visit: 30/60/120/180) and type "alert" (on events like a new or cancelled booking).\nACTIONS:\n• list. • get — id.\n• update — id + any of: content (default text, ≥2), content_push / content_sms / content_whatsapp / content_email (per-channel text; empty = use content), email_enabled / sms_enabled / whatsapp_enabled / push_enabled, duration (reminders only). The rest is echoed.\n• reset_defaults — restore ALL templates to the platform defaults (confirm first: it overwrites custom wording).\n• activate / deactivate — id.\nA channel switched off in reminder_channels (or locked for the account) stays off regardless.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'update', 'reset_defaults', 'activate', 'deactivate']),
        id: idLike.optional(),
        content: z.string().min(2).optional(),
        content_push: z.string().optional(),
        content_sms: z.string().optional(),
        content_whatsapp: z.string().optional(),
        content_email: z.string().optional(),
        email_enabled: z.boolean().optional(),
        sms_enabled: z.boolean().optional(),
        whatsapp_enabled: z.boolean().optional(),
        push_enabled: z.boolean().optional(),
        duration: z.union([z.literal(30), z.literal(60), z.literal(120), z.literal(180)]).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return api.get('/reminders');
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/reminders/${input.id}`);
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/reminders/${input.id}`);
            const payload: Record<string, any> = { content: input.content ?? current?.content ?? '' };
            for (const k of ['email_enabled', 'sms_enabled', 'whatsapp_enabled', 'push_enabled'] as const) {
              payload[k] = input[k] !== undefined ? bool01(input[k]) : flag01(current?.[k]);
            }
            for (const k of ['content_push', 'content_sms', 'content_whatsapp', 'content_email'] as const) {
              const v = input[k] ?? current?.[k];
              if (v !== undefined && v !== null && v !== '') payload[k] = v;
            }
            if ((current?.type ?? current?.reminder?.type) === 'reminder') {
              payload.duration = input.duration ?? current?.duration ?? 60;
            }
            return api.putViaPost(`/reminders/${input.id}`, payload, { multipart: true });
          }
          case 'reset_defaults':
            return api.post('/reminders/reset-defaults');
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/reminders/${input.id}/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — reminder_channels
    // ════════════════════════════════════════════════════════════════

    {
      name: 'reminder_channels',
      description:
        'Account-wide notification channels (email / SMS / WhatsApp / push) above the per-template switches.\nACTIONS:\n• get — the four switches + `platform` (which channels this account may use at all: platform setting, the admin\'s per-account switch, and for WhatsApp the package feature). A locked channel can\'t be turned on — explain why instead of offering it.\n• update — any of email_enabled / sms_enabled / whatsapp_enabled / push_enabled; the rest is echoed.',
      inputSchema: z.object({
        action: z.enum(['get', 'update']),
        email_enabled: z.boolean().optional(),
        sms_enabled: z.boolean().optional(),
        whatsapp_enabled: z.boolean().optional(),
        push_enabled: z.boolean().optional(),
      }),
      handler: async (input) => {
        if (input.action === 'get') return api.get('/reminder-channels');
        const current = await api.get('/reminder-channels');
        const payload: Record<string, any> = {};
        for (const k of ['email_enabled', 'sms_enabled', 'whatsapp_enabled', 'push_enabled'] as const) {
          payload[k] = input[k] !== undefined ? bool01(input[k]) : flag01(current?.[k]);
        }
        return api.putViaPost('/reminder-channels', payload, { multipart: true });
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — settings
    // ════════════════════════════════════════════════════════════════

    {
      name: 'settings',
      description:
        'Booking settings.\nACTIONS:\n• get.\n• update — any of: booking_differance (minimum notice in minutes before a customer can book), calender_differance (calendar slot step, 5-30 minutes), cancel_booking (customers may cancel), reviews_enabled, employee_assignment_mode (fewest_employees = keep a visit with as few specialists as possible, time = earliest free specialist per service), calendar_view_mode (splitted = one card per service, grouped = consecutive services of the same specialist in one card), accept_payment (cash / online / both — write-only), google_reviews_min_stars (1-5, which Google reviews show), google_review_boost_enabled + google_review_boost_min_stars (invite happy customers to review on Google), terms. The rest is kept.',
      inputSchema: z.object({
        action: z.enum(['get', 'update']),
        booking_differance: z.number().int().min(0).optional(),
        calender_differance: z.number().int().min(5).max(30).optional(),
        cancel_booking: z.boolean().optional(),
        reviews_enabled: z.boolean().optional(),
        employee_assignment_mode: z.enum(['fewest_employees', 'time']).optional(),
        calendar_view_mode: z.enum(['splitted', 'grouped']).optional(),
        accept_payment: z.enum(['cash', 'online', 'both']).optional(),
        google_reviews_min_stars: z.number().int().min(1).max(5).optional(),
        google_review_boost_enabled: z.boolean().optional(),
        google_review_boost_min_stars: z.number().int().min(1).max(5).optional(),
        terms: z.string().min(3).optional(),
      }),
      handler: async (input) => {
        if (input.action === 'get') return api.get('/settings');
        const current = await api.get('/settings');
        return api.putViaPost(
          '/settings',
          clean({
            booking_differance: input.booking_differance ?? current?.booking_differance ?? 0,
            calender_differance: input.calender_differance ?? current?.calender_differance ?? 15,
            cancel_booking: input.cancel_booking !== undefined ? bool01(input.cancel_booking) : flag01(current?.cancel_booking),
            reviews_enabled: bool01(input.reviews_enabled),
            employee_assignment_mode: input.employee_assignment_mode,
            calendar_view_mode: input.calendar_view_mode,
            accept_payment: input.accept_payment,
            google_reviews_min_stars: input.google_reviews_min_stars,
            google_review_boost_enabled: bool01(input.google_review_boost_enabled),
            google_review_boost_min_stars: input.google_review_boost_min_stars,
            terms: input.terms,
          }),
          { multipart: true },
        );
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — google_calendar
    // ════════════════════════════════════════════════════════════════

    {
      name: 'google_calendar',
      description:
        'Two-way Google Calendar sync (package feature google_calendar): bookings go to each employee\'s calendar, and busy Google events block booking slots.\nACTIONS:\n• status — connected, account email, sync_enabled, calendars, employees with their mapped calendar.\n• connect — returns a `url` the VENDOR opens to grant access (you can\'t do it for them). Each employee gets a calendar automatically.\n• disconnect — removes the connection and all mappings (confirm first).\n• update_settings — any of sync_enabled, default_calendar_id ("" clears), mappings {"<employee_id>": "<calendar_id>" or ""}.\n• create_calendar — name → new calendar id to map.\n• reschedule_event — move an EXTERNAL Google event (from get_calendar external_busy): calendar_id, event_id, start_time, end_time ("YYYY-MM-DD HH:MM" Saudi local), optional employee_id.\nA 400 "لم يتم ربط تقويم Google بعد" means run connect first.',
      inputSchema: z.object({
        action: z.enum(['status', 'connect', 'disconnect', 'update_settings', 'create_calendar', 'reschedule_event']),
        return_url: z.string().optional(),
        sync_enabled: z.boolean().optional(),
        default_calendar_id: z.string().max(255).optional(),
        mappings: idKeyedMap.optional(),
        name: z.string().min(1).max(120).optional(),
        calendar_id: z.string().max(255).optional(),
        event_id: z.string().max(255).optional(),
        employee_id: idLike.optional(),
        start_time: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/).optional(),
        end_time: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/).optional(),
      }),
      handler: async (input) => {
        const toHms = (v: string) => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v) ? `${v}:00` : v);
        switch (input.action) {
          case 'status':
            return api.get('/google-calendar');
          case 'connect':
            return api.get('/google-calendar/connect', clean({ return_url: input.return_url }));
          case 'disconnect':
            return api.post('/google-calendar/disconnect');
          case 'update_settings': {
            const payload: Record<string, any> = {};
            if (input.sync_enabled !== undefined) payload.sync_enabled = bool01(input.sync_enabled);
            if (input.default_calendar_id !== undefined) payload.default_calendar_id = input.default_calendar_id;
            if (input.mappings && Object.keys(input.mappings).length) payload.mappings = input.mappings;
            if (!Object.keys(payload).length) throw new Error('update_settings needs sync_enabled, default_calendar_id or mappings.');
            return api.putViaPost('/google-calendar/settings', payload, { multipart: true });
          }
          case 'create_calendar':
            require(input, ['name'], 'create_calendar');
            return api.post('/google-calendar/calendar', { name: input.name }, { multipart: true });
          case 'reschedule_event':
            require(input, ['calendar_id', 'event_id', 'start_time', 'end_time'], 'reschedule_event');
            return api.putViaPost(
              '/google-calendar/event',
              clean({
                calendar_id: input.calendar_id,
                event_id: input.event_id,
                employee_id: input.employee_id,
                start_time: toHms(input.start_time!),
                end_time: toHms(input.end_time!),
              }),
              { multipart: true },
            );
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — subscription
    // ════════════════════════════════════════════════════════════════

    {
      name: 'subscription',
      description:
        'The vendor\'s plan and billing ("اشتراكي").\nACTIONS:\n• packages — plans the vendor can pick (price for its period, limits, `features`).\n• list — subscription history, newest first. • get — id.\n• create — package_id (from packages) + auto_renew. Creates a pending subscription.\n• checkout — subscription_id → `redirectUrl`, a payment page the VENDOR opens to pay (you can\'t pay for them). Then poll check_is_paid.\n• check_is_paid — subscription_id → payment_status (active once paid).\n• activate_free — subscription_id of a FREE (price 0) plan; priced plans are refused.\n• set_auto_renew — id + auto_renew.\nBilling is sensitive: spell out the plan name, price, period and limits and get an explicit yes before create / checkout / activate_free.',
      inputSchema: z.object({
        action: z.enum([
          'packages',
          'list',
          'get',
          'create',
          'checkout',
          'check_is_paid',
          'activate_free',
          'set_auto_renew',
        ]),
        id: idLike.optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(50).optional(),
        package_id: idLike.optional(),
        auto_renew: z.boolean().optional(),
        subscription_id: idLike.optional(),
      }),
      handler: async (input) => {
        const paging = clean({ limit: input.per_page, offset: input.page });
        switch (input.action) {
          case 'packages':
            return pageOf(await api.getRaw('/packages', paging), (p: any) => clean({
              id: p.id,
              name: p.name_ar,
              description: p.description_ar,
              period: p.period,
              days: p.days,
              price: p[`${p.period}_price`],
              branches: p.branches,
              employees: p.employees,
              customers: p.customers,
              sms_messages: p.sms_messages,
              whatsapp_messages: p.whatsapp_messages,
              commission: p.commission,
              features: p.features,
            }));
          case 'list':
            return pageOf(await api.getRaw('/subscriptions', { ...paging, sort: 'DESC', with: ['package'] }));
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/subscriptions/${input.id}`);
          case 'create':
            require(input, ['package_id'], 'create');
            if (input.auto_renew === undefined) {
              throw new Error('action="create" requires auto_renew (true/false) — ask the vendor.');
            }
            return api.post(
              '/subscriptions',
              { package_id: input.package_id, auto_renew: bool01(input.auto_renew) },
              { multipart: true },
            );
          case 'checkout':
          case 'check_is_paid':
          case 'activate_free': {
            require(input, ['subscription_id'], input.action);
            const paths: Record<string, string> = { checkout: 'checkout', check_is_paid: 'check_is_paid', activate_free: 'activate-free' };
            const path = paths[input.action];
            return api.post(`/subscriptions/${path}`, { subscription_id: input.subscription_id }, { multipart: true });
          }
          case 'set_auto_renew':
            require(input, ['id'], 'set_auto_renew');
            if (input.auto_renew === undefined) throw new Error('action="set_auto_renew" requires auto_renew.');
            return api.putViaPost(`/subscriptions/${input.id}`, { auto_renew: bool01(input.auto_renew) }, { multipart: true });
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — zatca
    // ════════════════════════════════════════════════════════════════

    {
      name: 'zatca',
      description:
        'ZATCA e-invoicing (Phase 2).\nACTIONS:\n• get — seller data, national address, `registered`, `active`, `status`, `environments` (the only environment this server allows), certificate_expires_at. Tax invoices are real only when registered=1 AND active=1.\n• update — seller data; omitted fields keep their stored value: seller_name_ar, seller_name_en, tax_number (15 digits, starts and ends with 3), commercial_no, address, and the national address: address_building_number (4 digits), address_street, address_district, address_city, address_postal_code (5 digits), address_additional_number (4 digits, optional).\n• register — otp (6 digits from the Fatoora portal); environment defaults to the allowed one. Needs commercial_no and the full national address first. Registering in production is irreversible — confirm with extreme care.\n• activate / deactivate — start/stop issuing tax invoices (activate after a successful register).',
      inputSchema: z.object({
        action: z.enum(['get', 'update', 'register', 'activate', 'deactivate']),
        seller_name_ar: z.string().min(2).optional(),
        seller_name_en: z.string().min(2).optional(),
        tax_number: z.string().regex(/^3\d{13}3$/, '15 digits starting and ending with 3').optional(),
        commercial_no: z.string().max(50).optional(),
        address: z.string().min(2).optional(),
        address_building_number: z.string().regex(/^\d{4}$/).optional(),
        address_street: z.string().max(150).optional(),
        address_district: z.string().max(100).optional(),
        address_city: z.string().max(100).optional(),
        address_postal_code: z.string().regex(/^\d{5}$/).optional(),
        address_additional_number: z.string().regex(/^\d{4}$/).optional(),
        environment: z.enum(['sandbox', 'production']).optional(),
        otp: z.string().regex(/^\d{6}$/).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'get':
            return api.get('/zatca');
          case 'update': {
            const current = await api.get('/zatca');
            const fields = [
              'seller_name_ar',
              'seller_name_en',
              'tax_number',
              'commercial_no',
              'address',
              'address_building_number',
              'address_street',
              'address_district',
              'address_city',
              'address_postal_code',
              'address_additional_number',
            ] as const;
            const payload: Record<string, any> = {};
            for (const f of fields) {
              const v = input[f] ?? current?.[f];
              if (v !== undefined && v !== null && v !== '') payload[f] = v;
            }
            const missing = ['seller_name_ar', 'seller_name_en', 'tax_number', 'address'].filter((f) => !payload[f]);
            if (missing.length) throw new Error(`ZATCA needs ${missing.join(', ')} — ask the vendor for them.`);
            return api.putViaPost('/zatca', payload, { multipart: true });
          }
          case 'register': {
            require(input, ['otp'], 'register');
            const current = await api.get('/zatca');
            const allowed: string[] = Array.isArray(current?.environments) ? current.environments : [];
            const environment = input.environment ?? allowed[0];
            if (!environment || (allowed.length && !allowed.includes(environment))) {
              throw new Error(`This server only allows: ${allowed.join(', ') || 'none'}.`);
            }
            return api.post('/zatca/register', { environment, otp: input.otp }, { multipart: true });
          }
          case 'activate':
          case 'deactivate':
            return api.post(`/zatca/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — business_profile
    // ════════════════════════════════════════════════════════════════

    {
      name: 'business_profile',
      description:
        'The business details shown to customers and used on invoices.\nACTIONS:\n• get — name, description, website_url, instagram, tiktok, seller names, tax_number, commercial_no, address and the national address fields.\n• update — send only what changes; an empty string "" clears a field (name can\'t be cleared). website_url / instagram / tiktok must be full URLs (https://…). tax_number: 15 digits starting and ending with 3.',
      inputSchema: z.object({
        action: z.enum(['get', 'update']),
        name: z.string().max(100).optional(),
        description: z.string().max(500).optional(),
        website_url: z.string().max(200).optional(),
        instagram: z.string().max(200).optional(),
        tiktok: z.string().max(200).optional(),
        seller_name_ar: z.string().max(150).optional(),
        seller_name_en: z.string().max(150).optional(),
        tax_number: z.string().optional(),
        commercial_no: z.string().max(50).optional(),
        address: z.string().max(255).optional(),
        address_building_number: z.string().optional(),
        address_street: z.string().max(150).optional(),
        address_district: z.string().max(100).optional(),
        address_city: z.string().max(100).optional(),
        address_postal_code: z.string().optional(),
        address_additional_number: z.string().optional(),
      }),
      handler: async (input) => {
        if (input.action === 'get') return api.get('/business-profile');
        const { action, ...fields } = input;
        const payload = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        if (Object.keys(payload).length === 0) throw new Error('action="update" needs at least one field.');
        return api.putViaPost('/business-profile', payload, { multipart: true });
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — online_payment (read-only)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'online_payment',
      description:
        'Online (card / Apple Pay) payment status. Read-only — activation and bank details are done in the dashboard.\nACTIONS:\n• status — mode (direct/fast/platform/none), enabled, what customers can pay with (cash/online/both), payout account, onboarding state, processing rates.\n• payouts — what the platform owes the vendor from online payments: totals (pending / transferred) and settlement rows. Optional page, per_page.',
      inputSchema: z.object({
        action: z.enum(['status', 'payouts']),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(5).max(50).optional(),
      }),
      handler: async (input) => {
        const mask = (v: any) => (typeof v === 'string' && v.length > 4 ? `••••${v.slice(-4)}` : v);
        const res: any =
          input.action === 'status'
            ? await api.get('/online-payment')
            : await api.get('/online-payment/payouts', clean({ page: input.page, per_page: input.per_page }));
        for (const holder of [res?.payout, res?.payout_account]) {
          if (holder && typeof holder === 'object') holder.iban = mask(holder.iban);
        }
        return res;
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — payment_link (QR / pay-by-link)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'payment_link',
      description:
        'Collect a booking\'s payment online: a QR / link locked to the booking total that the customer pays on their phone; once paid the booking is settled. Needs online payment enabled (online_payment action="status").\nACTIONS:\n• create — booking_id → id, amount, expires_at (~15 min) and pay_url (show it, or send it).\n• send — id + pay_url (from create) → texts the link by WhatsApp, falling back to SMS. Optional phone + name (default: the booking\'s customer), channel (auto/sms/whatsapp). Max 3 sends per link per 15 min.\n• status — id → pending / checkout_started / paid / declined / expired / cancelled.\n• cancel — id. Do this if the customer won\'t pay now.\nWhile a link is pending or in checkout the booking is LOCKED: edits, reschedules and status changes fail with 409 until it is paid, cancelled or expired. Confirm the amount with the vendor before create.',
      inputSchema: z.object({
        action: z.enum(['create', 'send', 'status', 'cancel']),
        id: idLike.optional(),
        booking_id: idLike.optional(),
        pay_url: z.string().optional(),
        phone: z.string().max(30).optional(),
        name: z.string().max(100).optional(),
        channel: z.enum(['auto', 'sms', 'whatsapp']).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'create': {
            require(input, ['booking_id'], 'create');
            const booking = await api.get(`/bookings/${input.booking_id}`);
            const branchId = booking?.branch?.id ?? booking?.branch_id;
            if (!branchId) throw new Error('Could not resolve the booking\'s branch.');
            const req: any = await api.post(
              `/branches/${branchId}/payment-requests`,
              { booking_id: input.booking_id },
              { multipart: true },
            );
            return clean({
              id: req?.id,
              reference: req?.reference,
              status: req?.status,
              amount: req?.amount,
              currency: req?.currency,
              expires_at: req?.expires_at,
              pay_url: req?.pay_url,
              message: req?.message,
            });
          }
          case 'send': {
            require(input, ['id', 'pay_url'], 'send');
            const token = String(input.pay_url).split(/[/?#]/).filter(Boolean).find((part) => /^[A-Za-z0-9]{64}$/.test(part));
            if (!token) throw new Error('pay_url must be the link returned by action="create".');
            return api.post(
              `/payment-requests/${input.id}/send-link`,
              clean({ token, channel: input.channel, phone: input.phone, name: input.name }),
              { multipart: true },
            );
          }
          case 'status':
            require(input, ['id'], 'status');
            return api.get(`/payment-requests/${input.id}`);
          case 'cancel':
            require(input, ['id'], 'cancel');
            return api.post(`/payment-requests/${input.id}/cancel`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — account
    // ════════════════════════════════════════════════════════════════

    {
      name: 'account',
      description:
        'The signed-in user\'s own account.\nACTIONS:\n• update_profile — first_name (2-50, required by the backend: echoed when omitted), last_name, and for the owner: description (≤500), website_url, instagram, tiktok, terms. Empty values are ignored here — use business_profile to clear them.\n• send_code — destination: the NEW email or Saudi mobile; a 6-digit code goes there (valid 10 min).\n• update_email — email + code; update_phone — phone + code (same destination as send_code).\n• change_password — new_password (≥8); current_password unless get_profile says has_password=false. It signs the user out of every other device (app, dashboard) — say so before confirming.\nConfirm every account change first.',
      inputSchema: z.object({
        action: z.enum(['update_profile', 'send_code', 'update_email', 'update_phone', 'change_password']),
        first_name: z.string().min(2).max(50).optional(),
        last_name: z.string().max(50).optional(),
        description: z.string().max(500).optional(),
        website_url: z.string().min(3).max(200).optional(),
        instagram: z.string().min(3).max(200).optional(),
        tiktok: z.string().min(3).max(200).optional(),
        terms: z.string().min(3).optional(),
        destination: z.string().optional().describe('send_code: the new email or Saudi mobile (05…).'),
        email: z.string().email().optional(),
        phone: z.string().min(9).optional(),
        code: z.string().regex(/^\d{6}$/).optional(),
        current_password: z.string().optional(),
        new_password: z.string().min(8).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'update_profile': {
            let firstName = input.first_name;
            if (firstName === undefined) firstName = (await api.get('/profile'))?.first_name;
            return api.post(
              '/update-profile',
              clean({
                first_name: firstName,
                last_name: input.last_name,
                description: input.description,
                website_url: input.website_url,
                instagram: input.instagram,
                tiktok: input.tiktok,
                terms: input.terms,
              }),
              { multipart: true },
            );
          }
          case 'send_code':
            require(input, ['destination'], 'send_code');
            return api.post('/send-code', { username: input.destination!.trim() }, { multipart: true });
          case 'update_email':
            require(input, ['email', 'code'], 'update_email');
            return api.post('/update-email', { email: input.email, code: input.code }, { multipart: true });
          case 'update_phone':
            require(input, ['phone', 'code'], 'update_phone');
            return api.post('/update-phone', { phone: input.phone, code: input.code }, { multipart: true });
          case 'change_password':
            require(input, ['new_password'], 'change_password');
            return api.post(
              '/change-password',
              clean({
                current_password: input.current_password,
                password: input.new_password,
                password_confirmation: input.new_password,
              }),
              { multipart: true },
            );
        }
      },
    },
  ];
}
