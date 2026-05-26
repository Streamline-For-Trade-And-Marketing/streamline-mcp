/**
 * Tool definitions for the Streamline MCP server (v0.6 — action-based).
 *
 * Surface: **25 tools** (down from v0.5's 93). Every CRUD-style resource
 * is now exposed as ONE "umbrella" tool that takes an `action` enum.
 * Examples:
 *   • `offer` covers list / get / create / update / activate / deactivate
 *   • `booking` covers list / get / create / cancel / complete /
 *      mark_no_show / reschedule / update_notes
 *   • `account` covers change_password / send_code / update_email /
 *      update_phone / update_profile
 *
 * Why action-based: 93 distinct tools made the system prompt unwieldy
 * and forced Claude to scan a long list on every reply. Grouping by
 * resource matches how the vendor THINKS ("about offers, …", "for
 * employees, …") and shortens the tool catalogue dramatically.
 *
 * Within an umbrella tool, every field is OPTIONAL at the zod layer
 * because requirements differ per action. The DESCRIPTION block lays
 * out which fields are required for each action — Claude reads it
 * once and dispatches correctly. The handler enforces per-action
 * validation at runtime so the backend never sees a malformed call.
 *
 * DELETE OPERATIONS ARE NOT EXPOSED.
 * Per vendor instruction: this MCP cannot delete bookings / services /
 * employees / branches / offers / promo codes / sections / roles. All
 * removal happens via the activate/deactivate pair on each umbrella.
 *
 * Saudi-first identity. The global conventions block on `get_profile`
 * tells Claude to:
 *   1. Always answer in Najdi Saudi Arabic when the user writes Arabic.
 *   2. Present multi-choice options when asking the vendor for input,
 *      never demand free text.
 *   3. Lean into the Saudi identity of the product — SAR, Saudi cities,
 *      cultural context.
 *
 * The Saudi-Arabia timezone helpers (Asia/Riyadh, UTC+3, no DST), the
 * ZATCA-aware VAT stripping, the walk-in sentinel guard, and the
 * "completed bookings are final" rule from v0.5 are all preserved.
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

/**
 * Strip null/undefined query params so we don't send `?branch_id=null`
 * (Laravel happily parses that as a literal string and the filter
 * misses). Booleans are kept as-is.
 */
function clean<T extends Record<string, any>>(o: T): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Guard: refuse to mutate a booking whose status is already `completed`.
 *
 * The backend's `BookingRequest` validator allows `status` to transition
 * from anything to anything — that's intentional on the backend (admin
 * tooling sometimes needs to retro-fix records) but for vendor
 * conversations through Claude it's a footgun: a completed booking has
 * an issued invoice and balanced wallet transactions, and any status
 * flip after that desyncs reports and tax records.
 *
 * Per vendor instruction: completed bookings are FINAL — block at this
 * layer. Notes-only edits are NOT blocked because they're metadata.
 */
function ensureNotCompleted(detail: any, action: string): void {
  const status = String(detail?.status ?? '').toLowerCase();
  if (status === 'completed') {
    const id = detail?.id ?? '?';
    throw new Error(
      `Cannot ${action} booking #${id} — its status is already "completed" and the invoice is issued. Completed bookings are final at this layer to keep reports and ZATCA invoices balanced. If a refund or correction is really needed, do it through the admin tool — not the vendor MCP.`,
    );
  }
}

/**
 * Resolve the booking's existing customer user_id from a detail
 * response. Walk-in bookings expose `customer: { id: 0, name: "عميل
 * تلقائي" }` — a sentinel that ISN'T a real users.id. Only return a
 * strictly positive integer; everything else means "walk-in, drop the
 * field from the wire".
 */
function existingCustomerId(detail: any): number | null {
  const candidate =
    detail?.user?.id ?? detail?.user_id ?? detail?.customer?.id ?? null;
  const n = Number(candidate);
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}

/**
 * Pull service_ids + offer_ids off a booking detail so a round-trip
 * PUT preserves the offer association when present. Without this, an
 * offer-based booking recomputes pricing from underlying services on
 * the PUT and the discount silently disappears from the total.
 */
function existingServiceAndOfferIds(detail: any): {
  service_ids: any[];
  offer_ids: any[];
} {
  const items =
    detail?.booking_items ??
    detail?.bookingService ??
    detail?.booking_services ??
    detail?.services ??
    [];
  const serviceIds = new Set<any>();
  const offerIds = new Set<any>();
  if (Array.isArray(items)) {
    items.forEach((it: any) => {
      const offerId = it?.offer_id ?? it?.offer?.id ?? null;
      const serviceId = it?.service_id ?? it?.service?.id ?? it?.id ?? null;
      if (offerId != null) offerIds.add(offerId);
      else if (serviceId != null) serviceIds.add(serviceId);
    });
  }
  return {
    service_ids: Array.from(serviceIds),
    offer_ids: Array.from(offerIds),
  };
}

/**
 * Strip VAT / tax fields from a booking object when the vendor is
 * NOT ZATCA-active. The backend pre-computes 15% VAT into every
 * booking regardless of ZATCA status — mirroring the mobile app, we
 * hide those numbers when the vendor doesn't actually issue tax
 * invoices, so the model doesn't tell them "you collected X SAR
 * tax" when no invoice was issued.
 */
function stripVatFields<T>(booking: T): T {
  if (!booking || typeof booking !== 'object') return booking;
  const cloned: any = JSON.parse(JSON.stringify(booking));
  const VAT_KEYS = [
    'vat',
    'total_vat',
    'tax',
    'total_tax',
    'vat_value',
    'vat_percentage',
  ];
  for (const k of VAT_KEYS) delete cloned[k];
  const stripList = (arr: any) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item) => {
      if (item && typeof item === 'object') {
        for (const k of VAT_KEYS) delete item[k];
      }
    });
  };
  stripList(cloned.booking_items);
  stripList(cloned.booking_services);
  stripList(cloned.bookingService);
  stripList(cloned.services);
  return cloned;
}

/** "Either a number or a string id" — accepted by every backend FK. */
const idLike = z.union([z.number(), z.string()]);

const hourPattern = /^\d{1,2}:\d{2}$/;
const dayEnum = z.enum(['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri']);

/** A working-hours row: { day, start_time, end_time }. */
const hourRowSchema = z.object({
  day: dayEnum,
  start_time: z.string().regex(hourPattern, 'HH:MM (24h) e.g. "09:00"'),
  end_time: z.string().regex(hourPattern, 'HH:MM (24h) e.g. "21:00"'),
});

/** Convert MCP's boolean to Laravel's `'0'/'1'` string. */
function bool01(v: boolean | undefined): '0' | '1' | undefined {
  if (v === undefined) return undefined;
  return v ? '1' : '0';
}

/**
 * Throw a clean error when a required-per-action field is missing.
 * Keeps the per-action handlers focused on the happy path.
 */
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

// ════════════════════════════════════════════════════════════════════
//  GLOBAL CONVENTIONS — embedded in get_profile, referenced from
//  every umbrella tool's description.
// ════════════════════════════════════════════════════════════════════

const GLOBAL_CONVENTIONS = `**GLOBAL CONVENTIONS — APPLY TO EVERY REPLY:**

• **منتج سعودي 🇸🇦** — Streamline is a Saudi product built for the Saudi market. The vendor is in Saudi Arabia, operates in Saudi Riyal (ر.س / SAR), and the storefront defaults to Arabic. Lean into the Saudi identity: reference Saudi cities, the Hijri week (السبت is the start of the work week, not Monday), and Saudi cultural context. The product is NOT global.

• **اللهجة النجدية السعودية** — when the user writes in Arabic, REPLY IN NAJDI SAUDI DIALECT, not Egyptian, not Levantine, not formal MSA. Examples of the tone:
   – "وش" / "ايش" بدل "ما هو"
   – "ابغى" / "ابي" بدل "أريد"
   – "خلاص" / "تمام" / "زين" بدل "حسنًا"
   – "اوكي" / "أوكي" / "كذا" / "هذي" / "هذا"
   – "كم تبي / كم ودك" بدل "كم تريد"
   – "تكفى" / "لو سمحت" — استخدمها بأدب نجدي
   – عبارات سعودية: "ابشر / يعطيك العافية / حياك الله / على راسي"
   Keep the warmth and directness Saudis use with each other. If the user switches to English, follow them.

• **اسأل بخيارات، لا تطلب نص مفتوح** — when you need information from the vendor (which branch / which employee / which service / which date / which customer), ALWAYS present 2-4 concrete options as a numbered or bulleted list and let them pick. NEVER ask "وش الفرع؟" without listing the branches you already pulled via list_* tools. If only one option fits, just confirm it ("تقصد فرع النخيل؟ ✓ / ✗") instead of asking. The vendor is on a phone — typing free-text answers slows them down.
   Pattern when asking:
     "تبي اعرضها على أي فرع؟
      ١) حلاق النخيل
      ٢) حلاق الورود
      ٣) كل الفروع"
   Pattern when confirming a write:
     "تأكيد العملية:
      • العميل: أحمد ٠٥٠١٢٣٤٥٦٧
      • الخدمة: حلاقة + لحية (٤٥ ر.س)
      • الوقت: السبت ٩م
      اضغط ١ لتأكيد، ٢ للتعديل، ٣ للإلغاء."

• **التوقيت السعودي** — the vendor operates in Saudi Arabia (Asia/Riyadh, UTC+3, no DST). When the user says "اليوم / بكره / الليلة / هذا الأسبوع" they mean Saudi-local. NEVER guess or compute unix timestamps in your head — first call \`get_current_time\` to get today's Saudi date, then pass \`local_datetime\` (YYYY-MM-DD HH:MM Saudi-local) to booking actions and let the server convert.

• **أرقام الـ IDs داخلية** — id / branch_id / employee_id / service_id / customer_id are for YOUR follow-up tool calls only. NEVER include them in your reply to the vendor. Refer to entities by their human-readable names ("سمير" not "سمير id=10", "حلاق النخيل" not "branch 3", "حلاقة شعر للأطفال" not "service id=22").

• **العملة بالريال السعودي** — show prices as "٤٥ ر.س" or "45 SAR" (vendor preference). When ZATCA is inactive, NEVER mention VAT/tax numbers (they're stripped from the response — see the next rule).

• **الـ VAT شيلت تلقائياً** — VAT fields (vat, total_vat, tax) are stripped from booking responses when the vendor is not ZATCA-active. If the response has no VAT keys, the vendor cannot issue tax invoices — do NOT invent, mention, or compute tax numbers in your reply.

• **ما يوجد DELETE** — this MCP cannot delete bookings / services / employees / branches / offers / promo codes / sections / roles / cancellation reasons. If the vendor asks to "احذف" something, suggest deactivation instead (\`action: "deactivate"\` on the umbrella tool) — the resource is hidden from customers without losing historical data.

• **الواجهة بالعربي فقط** — the backend's \`name_en\` / \`description_en\` columns are nullable and NOT used by this MCP. Always send Arabic only. Never invent English placeholders.

• **كل أداة تستخدم \`action\`** — every umbrella tool takes an \`action\` parameter (enum). For example, the \`offer\` tool's \`action\` selects between list / get / create / update / activate / deactivate. The tool's description spells out which other fields are required for each action.

• **تأكيد قبل أي كتابة** — for every write action (create / update / cancel / activate / deactivate / etc.), REPEAT THE FULL CHANGE BACK TO THE VENDOR with concrete details (names, prices, times — not ids) and wait for explicit confirmation before invoking the tool.`;

// ════════════════════════════════════════════════════════════════════
//  TOOL BUILDER
// ════════════════════════════════════════════════════════════════════

export function buildTools(api: VendorClient): ToolDef[] {
  return [
    // ════════════════════════════════════════════════════════════════
    //  STANDALONES — single-purpose tools that don't fit an umbrella
    // ════════════════════════════════════════════════════════════════

    {
      name: 'get_profile',
      description:
        'Get the logged-in vendor account profile: name, email, phone, role, active subscription summary, and social links. Use this FIRST in any conversation so you anchor on the vendor\'s actual context.\n\n' +
        GLOBAL_CONVENTIONS,
      inputSchema: z.object({}),
      handler: async () => api.get('/profile'),
    },

    {
      name: 'get_current_time',
      description:
        'Returns the current date and time in **Saudi local timezone (Asia/Riyadh, UTC+3)**. The Streamline vendor lives in Saudi Arabia and all "اليوم / بكره / الحين" references are relative to this. Use this BEFORE every booking-related write so you know what "today" actually is — the model has no reliable internal clock.\n\nResponse: `date` (YYYY-MM-DD), `time` (HH:MM 24h), `weekday_ar` ("السبت"), `human` (formatted string), `unix_seconds`. Use the `date` field with the booking action\'s `local_datetime` parameter rather than computing unix yourself.',
      inputSchema: z.object({}),
      handler: async () => nowSaudi(),
    },

    {
      name: 'get_wallet',
      description:
        'Get the vendor wallet balance + recent transactions. Optional branch_id. Use for "كم في محفظتي / what\'s my balance".',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        per_page: z.number().int().min(1).max(50).optional(),
      }),
      handler: async (input) => api.get('/wallet', clean(input)),
    },

    {
      name: 'get_reports',
      description:
        'Pull aggregated KPIs for a given period. Backend supports SIX report types and SEVEN periods.\n\nTypes:\n• `home` (default) — revenue, bookings_count, AOV — the home dashboard payload.\n• `services` — per-service breakdown (count, revenue, top sellers).\n• `offers` — per-offer breakdown.\n• `customers` — top customers by visit count / spend.\n• `employees` — per-employee breakdown (bookings + revenue).\n• `employees_commissions` — payroll-style commission summary.\n\nPeriods: `day`, `week`, `month`, `3months`, `6months`, `9months`, `year`.\n\nOptional branch_id / employee_id to narrow. Use for "كم دخلي اليوم / كم كسبت هذا الشهر / من أعلى موظف عندي".',
      inputSchema: z.object({
        type: z
          .enum([
            'home',
            'services',
            'offers',
            'customers',
            'employees',
            'employees_commissions',
          ])
          .optional()
          .default('home'),
        period: z
          .enum(['day', 'week', 'month', '3months', '6months', '9months', 'year'])
          .default('month'),
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
      }),
      handler: async (input) =>
        api.get('/reports', clean({ type: 'home', ...input })),
    },

    {
      name: 'get_calendar',
      description:
        'Day-view list of bookings for a specific date + branch. Returns the same shape as `booking action="list"` but the backend filters to one day server-side, so this is the right tool for "اعرض جدول اليوم / show me tomorrow\'s calendar". `date` is YYYY-MM-DD. Optional employee_id narrows to one staff member.',
      inputSchema: z.object({
        branch_id: idLike,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        employee_id: idLike.optional(),
      }),
      handler: async (input) =>
        api.post('/calendar', clean(input), { multipart: true }),
    },

    {
      name: 'preview_booking',
      description:
        'Preview the price + duration + employee math for a potential booking WITHOUT creating it. Mirrors the in-app POS calculator — pass `branch_id` + `service_ids` (and/or `offer_ids`) + optional `employee_id`, and the backend returns the computed total, VAT (if ZATCA), per-service breakdown, and the available employees for those services. Use when the user asks "كم حصل لو حجز سمير حلاقة + لحية" before actually booking — gives them the number so they can decide. ALWAYS present the breakdown back to the user with options ("١) سجل الحجز / ٢) عدّل الخدمات / ٣) ألغ").',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
        service_ids: z.array(idLike).min(1).optional(),
        offer_ids: z.array(idLike).min(1).optional(),
      }),
      handler: async (input) =>
        api.post('/pos', clean(input), { multipart: true }),
    },

    {
      name: 'list_permissions',
      description:
        'List every permission node the vendor can assign to a role (e.g. `bookings.list`, `services.edit`, `wallets.list`). Use before `role action="create"` / `role action="update"` so you can construct the `permissions[]` array correctly. Present the permissions back to the user grouped by resource ("الحجوزات: عرض / إنشاء / تعديل …") with checkboxes, not raw permission names.',
      inputSchema: z.object({}),
      handler: async () => api.getRaw('/permissions'),
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — booking
    // ════════════════════════════════════════════════════════════════

    {
      name: 'booking',
      description:
        'Manage bookings. Pick an `action` to scope the call.\n\nACTIONS:\n• `list` — paginated booking list. Optional filters: branch_id, employee_id, status (`confirmed`/`completed`/`canceled`/`missed`/`not_confirmed`), date (YYYY-MM-DD), q (free-text search by customer), page, per_page.\n• `get` — one booking by id. Required: id.\n• `create` — new booking. Required: branch_id, employee_id, ONE OF { service_ids OR offer_ids }, ONE OF { local_datetime OR booking_timestamp }. Optional: customer_id (omit for walk-in), notes, payment_way (`cash`/`online`, default cash), status (`confirmed`/`completed`), payment_status (0/1).\n• `cancel` — cancel a booking. Required: id. Optional: cancellation_reason (free text 2-500 chars), cancel_reason_id (from `cancellation_reason action="list"`). Refuses on completed bookings.\n• `complete` — mark customer-showed + sale-rung. Sets status=completed AND payment_status=1. Required: id. Refuses on already-completed.\n• `mark_no_show` — customer didn\'t show. Sets status=missed. Required: id. Refuses on completed.\n• `reschedule` — move to a new time / employee. Required: id AND ONE OF { local_datetime OR booking_timestamp }. Optional: employee_id (else re-uses current). Refuses on completed.\n• `update_notes` — append or replace notes. Required: id, notes. Optional: mode (`append`/`replace`, default replace). ALLOWED on completed bookings (metadata only).\n\n**Walk-in support:** when the vendor doesn\'t mention a customer for a create, OMIT customer_id entirely — the backend tags it as walk-in ("عميل تلقائي"). NEVER ask "which customer?" when the vendor didn\'t mention one.\n\n**Offers vs services:** booking a regular service uses `service_ids: [10, 22]`. Booking an offer/promotion uses `offer_ids: [5]` and the backend resolves the underlying services + discount automatically. Both arrays can be passed together if bundling.\n\n**Timezone:** pass `local_datetime: { date: "YYYY-MM-DD", time: "HH:MM" }` in Saudi-local and the server converts to unix. NEVER compute unix timestamps yourself.\n\nCONFIRM the full change with the vendor before every write action.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'cancel',
          'complete',
          'mark_no_show',
          'reschedule',
          'update_notes',
        ]),
        id: idLike.optional(),
        // list filters
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
        status: z
          .enum([
            'confirmed',
            'completed',
            'canceled',
            'missed',
            'not_confirmed',
          ])
          .optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        q: z.string().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        // create
        customer_id: idLike.optional(),
        service_ids: z.array(idLike).min(1).optional(),
        offer_ids: z.array(idLike).min(1).optional(),
        local_datetime: z
          .object({
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            time: z.string().regex(hourPattern),
          })
          .optional(),
        booking_timestamp: z.number().int().optional(),
        notes: z.string().optional(),
        payment_way: z.enum(['cash', 'online']).optional(),
        payment_status: z.union([z.literal(0), z.literal(1)]).optional(),
        // cancel
        cancellation_reason: z.string().min(2).max(500).optional(),
        cancel_reason_id: idLike.optional(),
        // update_notes
        mode: z.enum(['append', 'replace']).optional(),
      }),
      handler: async (input) => {
        const zatca = await api.getZatcaState();
        const stripIfNeeded = (b: any) => (zatca.active ? b : stripVatFields(b));

        switch (input.action) {
          case 'list': {
            const res = await api.getRaw(
              '/bookings',
              clean({
                branch_id: input.branch_id,
                employee_id: input.employee_id,
                status: input.status,
                date: input.date,
                q: input.q,
                page: input.page,
                per_page: input.per_page,
              }),
            );
            if (zatca.active) return res;
            const items = res?.data?.data ?? res?.data ?? res;
            if (Array.isArray(items)) {
              const stripped = items.map(stripVatFields);
              if (res?.data?.data)
                return { ...res, data: { ...res.data, data: stripped } };
              if (res?.data) return { ...res, data: stripped };
              return stripped;
            }
            return res;
          }
          case 'get': {
            require(input, ['id'], 'get');
            return stripIfNeeded(await api.get(`/bookings/${input.id}`));
          }
          case 'create': {
            require(input, ['branch_id', 'employee_id'], 'create');
            if (
              !(input.service_ids && input.service_ids.length > 0) &&
              !(input.offer_ids && input.offer_ids.length > 0)
            ) {
              throw new Error(
                'action="create" requires at least one of `service_ids` or `offer_ids`.',
              );
            }
            let timestamp: number | undefined;
            if (input.local_datetime) {
              timestamp = saudiLocalToUnix(
                input.local_datetime.date,
                input.local_datetime.time,
              );
            } else if (input.booking_timestamp !== undefined) {
              timestamp = input.booking_timestamp;
            } else {
              throw new Error(
                'action="create" requires `local_datetime` (preferred, Saudi-local) or `booking_timestamp` (unix seconds).',
              );
            }
            const payload: Record<string, any> = {
              branch_id: input.branch_id,
              employee_id: input.employee_id,
              booking_timestamp: timestamp,
              payment_way: input.payment_way || 'cash',
              status: input.status || 'confirmed',
              payment_status: input.payment_status ?? 0,
              notes: input.notes || '',
              future_booking: input.status === 'completed' ? 0 : 1,
            };
            if (input.service_ids && input.service_ids.length > 0)
              payload.service_ids = input.service_ids;
            if (input.offer_ids && input.offer_ids.length > 0)
              payload.offer_ids = input.offer_ids;
            if (input.customer_id !== undefined && input.customer_id !== null)
              payload.customer_id = input.customer_id;
            return api.post('/bookings', payload, { multipart: true });
          }
          case 'cancel':
          case 'complete':
          case 'mark_no_show': {
            require(input, ['id'], input.action);
            const detail = await api.get(`/bookings/${input.id}`);
            ensureNotCompleted(
              detail,
              input.action === 'mark_no_show'
                ? 'mark as no-show'
                : input.action === 'complete'
                  ? 're-complete'
                  : 'cancel',
            );
            const { service_ids, offer_ids } = existingServiceAndOfferIds(detail);
            const payload: Record<string, any> = {
              branch_id: detail.branch?.id ?? detail.branch_id,
              employee_id: detail.employee?.id ?? detail.employee_id,
              customer_id: existingCustomerId(detail),
              payment_way: detail.payment_way || 'cash',
              payment_status:
                input.action === 'complete' ? 1 : detail.payment_status ?? 0,
              start_time: detail.start_time,
              booking_timestamp:
                detail.booking_timestamp ||
                Math.floor(
                  new Date(
                    String(detail.start_time).replace(' ', 'T'),
                  ).getTime() / 1000,
                ),
              notes: detail.notes || '',
              status:
                input.action === 'complete'
                  ? 'completed'
                  : input.action === 'mark_no_show'
                    ? 'missed'
                    : 'canceled',
            };
            if (service_ids.length > 0) payload.service_ids = service_ids;
            if (offer_ids.length > 0) payload.offer_ids = offer_ids;
            if (input.action === 'cancel') {
              if (input.cancellation_reason)
                payload.cancellation_reason = input.cancellation_reason;
              if (input.cancel_reason_id)
                payload.cancel_reason_id = input.cancel_reason_id;
            }
            return api.putViaPost(
              `/bookings/${input.id}`,
              clean(payload),
              { multipart: true },
            );
          }
          case 'reschedule': {
            require(input, ['id'], 'reschedule');
            const detail = await api.get(`/bookings/${input.id}`);
            ensureNotCompleted(detail, 'reschedule');
            let timestamp: number | undefined;
            if (input.local_datetime) {
              timestamp = saudiLocalToUnix(
                input.local_datetime.date,
                input.local_datetime.time,
              );
            } else if (input.booking_timestamp !== undefined) {
              timestamp = input.booking_timestamp;
            } else {
              throw new Error(
                'action="reschedule" requires `local_datetime` (preferred, Saudi-local) or `booking_timestamp`.',
              );
            }
            const resolvedEmployeeId =
              input.employee_id ?? detail.employee?.id ?? detail.employee_id;
            return api.post(
              `/bookings/${input.id}/reschedule`,
              clean({
                booking_timestamp: timestamp,
                employee_id: resolvedEmployeeId,
              }),
              { multipart: true },
            );
          }
          case 'update_notes': {
            require(input, ['id', 'notes'], 'update_notes');
            const detail = await api.get(`/bookings/${input.id}`);
            const { service_ids, offer_ids } =
              existingServiceAndOfferIds(detail);
            const nextNotes =
              input.mode === 'append' && detail.notes
                ? `${detail.notes}\n${input.notes}`
                : input.notes!;
            const payload: Record<string, any> = {
              branch_id: detail.branch?.id ?? detail.branch_id,
              employee_id: detail.employee?.id ?? detail.employee_id,
              customer_id: existingCustomerId(detail),
              payment_way: detail.payment_way || 'cash',
              payment_status: detail.payment_status ?? 0,
              status: detail.status,
              start_time: detail.start_time,
              booking_timestamp:
                detail.booking_timestamp ||
                Math.floor(
                  new Date(
                    String(detail.start_time).replace(' ', 'T'),
                  ).getTime() / 1000,
                ),
              notes: nextNotes,
            };
            if (service_ids.length > 0) payload.service_ids = service_ids;
            if (offer_ids.length > 0) payload.offer_ids = offer_ids;
            return api.putViaPost(
              `/bookings/${input.id}`,
              clean(payload),
              { multipart: true },
            );
          }
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — branch
    // ════════════════════════════════════════════════════════════════

    {
      name: 'branch',
      description:
        'Manage branches.\n\nACTIONS:\n• `list` — list branches. Optional: without_pagination (default true).\n• `get` — one branch by id. Required: id.\n• `create` — new branch. Required: name (Arabic), manager_id, country_id, region_id, city_id, address, lat, long (strings), official_hours (array of `{day, start_time, end_time}` per working day).\n• `update` — update one branch. Required: id. All other fields optional — current values echoed when omitted.\n• `activate` / `deactivate` — toggle is_active. Required: id. Deactivated branches stop accepting new bookings; existing ones stay intact.\n\nWhen the user references a branch by name, call `list` first to map it to its id. Never expose the id back to the user.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'update',
          'activate',
          'deactivate',
        ]),
        id: idLike.optional(),
        without_pagination: z.boolean().optional(),
        name: z.string().min(2).optional(),
        manager_id: idLike.optional(),
        country_id: idLike.optional(),
        region_id: idLike.optional(),
        city_id: idLike.optional(),
        address: z.string().min(2).optional(),
        lat: z.string().min(2).optional(),
        long: z.string().min(2).optional(),
        official_hours: z.array(hourRowSchema).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return api.get(
              '/branches',
              clean({
                without_pagination:
                  input.without_pagination !== false ? 'true' : undefined,
              }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/branches/${input.id}`);
          case 'create': {
            require(
              input,
              [
                'name',
                'manager_id',
                'country_id',
                'region_id',
                'city_id',
                'address',
                'lat',
                'long',
                'official_hours',
              ],
              'create',
            );
            return api.post(
              '/branches',
              {
                name: input.name,
                manager_id: input.manager_id,
                country_id: input.country_id,
                region_id: input.region_id,
                city_id: input.city_id,
                address: input.address,
                lat: input.lat,
                long: input.long,
                official_hours: input.official_hours,
              },
              { multipart: true },
            );
          }
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/branches/${input.id}`);
            const currentHours = Array.isArray(current.official_hours)
              ? current.official_hours.map((h: any) => ({
                  day: h.day,
                  start_time: h.start_time,
                  end_time: h.end_time,
                }))
              : [];
            return api.putViaPost(
              `/branches/${input.id}`,
              {
                name: input.name ?? current.name ?? '',
                manager_id:
                  input.manager_id ??
                  current.manager?.id ??
                  current.manager_id,
                country_id:
                  input.country_id ??
                  current.country?.id ??
                  current.country_id,
                region_id:
                  input.region_id ??
                  current.region?.id ??
                  current.region_id,
                city_id:
                  input.city_id ?? current.city?.id ?? current.city_id,
                address: input.address ?? current.address ?? '',
                lat: input.lat ?? String(current.lat ?? ''),
                long: input.long ?? String(current.long ?? ''),
                official_hours:
                  input.official_hours && input.official_hours.length > 0
                    ? input.official_hours
                    : currentHours,
              },
              { multipart: true },
            );
          }
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/branches/${input.id}/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — section
    // ════════════════════════════════════════════════════════════════

    {
      name: 'section',
      description:
        'Manage service sections (the groupings shown above the services tab: "قسم شعر", "قسم لحية", …).\n\nACTIONS:\n• `list` — list sections. Optional: branch_id, without_pagination (default true).\n• `create` — new section. Required: name_ar (≥2 chars). Optional: description_ar.\n• `update` — update one. Required: id. Optional: name_ar, description_ar, sort.\n• `activate` / `deactivate` — toggle visibility. Required: id.\n• `sort` — bulk reorder. Required: items (array of `{id, sort}`). Lower sort = top.\n\nArabic-only — name_en / description_en are not used by this MCP.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'create',
          'update',
          'activate',
          'deactivate',
          'sort',
        ]),
        id: idLike.optional(),
        branch_id: idLike.optional(),
        without_pagination: z.boolean().optional(),
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().min(2).optional(),
        sort: z.number().int().min(1).optional(),
        items: z
          .array(z.object({ id: idLike, sort: z.number().int().min(0) }))
          .min(1)
          .optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list': {
            const params: Record<string, any> = {};
            if (input.without_pagination !== false)
              params.without_pagination = 'true';
            if (input.branch_id) params.branch_id = input.branch_id;
            return api.getRaw('/sections', params);
          }
          case 'create':
            require(input, ['name_ar'], 'create');
            return api.post(
              '/sections',
              clean({
                name_ar: input.name_ar,
                description_ar: input.description_ar,
              }),
              { multipart: true },
            );
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/sections/${input.id}`);
            const payload: Record<string, any> = {
              name_ar: input.name_ar ?? current.name_ar ?? current.name ?? '',
            };
            if (input.description_ar !== undefined)
              payload.description_ar = input.description_ar;
            else if (current.description_ar)
              payload.description_ar = current.description_ar;
            if (input.sort !== undefined) payload.sort = input.sort;
            else if (typeof current.sort === 'number')
              payload.sort = current.sort;
            return api.putViaPost(`/sections/${input.id}`, payload, {
              multipart: true,
            });
          }
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/sections/${input.id}/${input.action}`);
          case 'sort':
            require(input, ['items'], 'sort');
            return api.post(
              '/sections/sort',
              { items: input.items },
              { multipart: true },
            );
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — service
    // ════════════════════════════════════════════════════════════════

    {
      name: 'service',
      description:
        'Manage services.\n\nACTIONS:\n• `list` — list services. Optional filters: branch_id, section_id, is_active (`0`/`1`), q, per_page.\n• `get` — one service by id. Required: id.\n• `create` — new service. Required: name_ar (≥2), description_ar (≥2), price, service_time (minutes), section_id, branch_id (array of ids). Optional: extra_time, featured, is_home_service + home_service_fee + home_hours (array of `{day, start_time, end_time}`).\n• `update` — full update. Required: id. All other fields optional — current values echoed when omitted.\n• `update_price` — fast price-only edit. Required: id, price. Optional: service_time, featured.\n• `activate` / `deactivate` — toggle is_active. Required: id.\n\nArabic-only. Home-service toggle: setting `is_home_service: false` WIPES existing home_hours server-side; setting it true requires `home_hours` to be passed alongside.\n\nCONFIRM the diff with the vendor before every write action.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'update',
          'update_price',
          'activate',
          'deactivate',
        ]),
        id: idLike.optional(),
        branch_id: z.union([idLike, z.array(idLike)]).optional(),
        section_id: idLike.optional(),
        is_active: z.enum(['0', '1']).optional(),
        q: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().min(2).optional(),
        price: z.number().nonnegative().optional(),
        service_time: z.number().int().positive().optional(),
        extra_time: z.number().int().nonnegative().optional(),
        featured: z.boolean().optional(),
        is_home_service: z.boolean().optional(),
        home_service_fee: z.number().nonnegative().optional(),
        home_hours: z.array(hourRowSchema).optional(),
      }),
      handler: async (input) => {
        const asBranchArray = (
          v: typeof input.branch_id,
        ): any[] | undefined => {
          if (v === undefined || v === null) return undefined;
          return Array.isArray(v) ? v : [v];
        };
        switch (input.action) {
          case 'list':
            return api.getRaw(
              '/services',
              clean({
                branch_id: Array.isArray(input.branch_id)
                  ? undefined
                  : input.branch_id,
                section_id: input.section_id,
                is_active: input.is_active,
                q: input.q,
                per_page: input.per_page,
              }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/services/${input.id}`);
          case 'create': {
            require(
              input,
              [
                'name_ar',
                'description_ar',
                'price',
                'service_time',
                'section_id',
                'branch_id',
              ],
              'create',
            );
            const branches = asBranchArray(input.branch_id);
            if (!branches || branches.length === 0) {
              throw new Error(
                'action="create" requires `branch_id` as an array of branch ids.',
              );
            }
            const payload: Record<string, any> = {
              name_ar: input.name_ar,
              description_ar: input.description_ar,
              price: input.price,
              service_time: input.service_time,
              section_id: input.section_id,
              branch_id: branches,
            };
            if (input.extra_time !== undefined)
              payload.extra_time = input.extra_time;
            if (input.featured !== undefined)
              payload.featured = bool01(input.featured);
            if (input.is_home_service) {
              payload.is_home_service = '1';
              if (input.home_service_fee !== undefined)
                payload.home_service_fee = input.home_service_fee;
              if (input.home_hours && input.home_hours.length > 0)
                payload.home_hours = input.home_hours;
            }
            return api.post('/services', payload, { multipart: true });
          }
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/services/${input.id}`);
            const currentBranchIds: any[] = Array.isArray(current.branches)
              ? current.branches.map((b: any) => b.id ?? b)
              : current.branch_id
                ? [current.branch_id]
                : [];
            const branches = asBranchArray(input.branch_id) ?? currentBranchIds;
            const payload: Record<string, any> = {
              name_ar:
                input.name_ar ?? current.name_ar ?? current.name ?? '',
              description_ar:
                input.description_ar ??
                current.description_ar ??
                current.description ??
                '-',
              price: input.price ?? current.price,
              service_time:
                input.service_time ?? current.service_time ?? 30,
              section_id:
                input.section_id ?? current.section?.id ?? current.section_id,
              branch_id: branches,
            };
            if (input.extra_time !== undefined)
              payload.extra_time = input.extra_time;
            else if (typeof current.extra_time === 'number')
              payload.extra_time = current.extra_time;
            const featuredVal = input.featured ?? current.featured;
            if (featuredVal !== undefined && featuredVal !== null) {
              payload.featured =
                typeof featuredVal === 'boolean'
                  ? bool01(featuredVal)
                  : Number(featuredVal)
                    ? '1'
                    : '0';
            }
            const homeOn =
              input.is_home_service !== undefined
                ? input.is_home_service
                : Number(current.is_home_service) === 1;
            if (homeOn) {
              payload.is_home_service = '1';
              if (input.home_service_fee !== undefined)
                payload.home_service_fee = input.home_service_fee;
              else if (current.home_service_fee !== undefined)
                payload.home_service_fee = current.home_service_fee;
              const hours =
                input.home_hours ??
                (Array.isArray(current.home_hours)
                  ? current.home_hours.map((h: any) => ({
                      day: h.day,
                      start_time: h.start_time,
                      end_time: h.end_time,
                    }))
                  : []);
              if (hours.length > 0) payload.home_hours = hours;
            } else if (input.is_home_service === false) {
              payload.is_home_service = '0';
            }
            return api.putViaPost(`/services/${input.id}`, payload, {
              multipart: true,
            });
          }
          case 'update_price': {
            require(input, ['id', 'price'], 'update_price');
            const current = await api.get(`/services/${input.id}`);
            const branchIds: any[] = Array.isArray(current.branches)
              ? current.branches.map((b: any) => b.id ?? b)
              : current.branch_id
                ? [current.branch_id]
                : [];
            return api.putViaPost(
              `/services/${input.id}`,
              {
                name_ar: current.name_ar || current.name || '',
                description_ar: current.description_ar || current.description || '-',
                section_id: current.section?.id ?? current.section_id,
                price: input.price,
                service_time:
                  input.service_time ?? current.service_time ?? 30,
                featured:
                  input.featured === undefined
                    ? current.featured
                      ? '1'
                      : '0'
                    : bool01(input.featured),
                branch_id: branchIds,
              },
              { multipart: true },
            );
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
        'Manage promotional offers.\n\nACTIONS:\n• `list` — list offers. Optional: branch_id, per_page.\n• `get` — one offer by id. Required: id.\n• `create` — new offer. Required: name_ar, description_ar, section_id, service_ids (array), branch_id (array), price_type, service_price. Conditional: discount_percentage (when price_type="discount"), offer_price (when price_type="special"). Optional home-service fields: is_home_service, home_service_fee, home_hours.\n• `update` — update one. Required: id. All other fields optional.\n• `activate` / `deactivate` — toggle is_active. Required: id.\n\nPRICE-TYPE SEMANTICS:\n• `service` → offer_price = service_price, discount = 0 (no discount; the offer is just bundling).\n• `free` → offer_price = 0, discount = 100 (100% off).\n• `discount` → caller provides discount_percentage; offer_price auto-computed.\n• `special` → caller provides offer_price; discount_percentage auto-computed.\n\nHOME-SERVICE (May-2026): offers can be flagged as home-delivery just like services. Pass `is_home_service: true` AND `home_hours: [{day, start_time, end_time}, ...]` to mark the offer as available at the customer\'s home. Optional `home_service_fee` is the surcharge layered on top of the offer\'s price. Toggling is_home_service OFF will WIPE existing home_hours server-side (delete-all-then-insert sync).\n\nArabic-only. CONFIRM the pricing math with the vendor before write actions.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'update',
          'activate',
          'deactivate',
        ]),
        id: idLike.optional(),
        branch_id: z.union([idLike, z.array(idLike)]).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().min(2).optional(),
        section_id: idLike.optional(),
        service_ids: z.array(idLike).min(1).optional(),
        price_type: z.enum(['service', 'free', 'discount', 'special']).optional(),
        service_price: z.number().nonnegative().optional(),
        discount_percentage: z.number().min(0).max(100).optional(),
        offer_price: z.number().nonnegative().optional(),
        sort: z.number().int().min(1).optional(),
        // May-2026 — home-delivery on offers (commit db0206b).
        // Same shape as the `service` umbrella's home fields so
        // vendors and the backend treat the two interchangeably.
        is_home_service: z.boolean().optional(),
        home_service_fee: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            'Surcharge added on top of the offer price for home-delivery bookings.',
          ),
        home_hours: z
          .array(hourRowSchema)
          .optional()
          .describe(
            'Required when is_home_service=true. Per-weekday windows when the offer can be booked at the customer\'s home.',
          ),
      }),
      handler: async (input) => {
        const computePricing = (
          type: 'service' | 'free' | 'discount' | 'special',
          servicePrice: number,
          discount: number,
          offerPrice: number,
        ): { discount_percentage: number; offer_price: number } => {
          switch (type) {
            case 'service':
              return { discount_percentage: 0, offer_price: servicePrice };
            case 'free':
              return { discount_percentage: 100, offer_price: 0 };
            case 'discount':
              return {
                discount_percentage: discount,
                offer_price: servicePrice * ((100 - discount) / 100),
              };
            case 'special':
              return {
                discount_percentage:
                  servicePrice > 0
                    ? ((servicePrice - offerPrice) / servicePrice) * 100
                    : 0,
                offer_price: offerPrice,
              };
          }
        };
        const asArray = (v: typeof input.branch_id): any[] | undefined => {
          if (v === undefined || v === null) return undefined;
          return Array.isArray(v) ? v : [v];
        };
        switch (input.action) {
          case 'list':
            return api.getRaw(
              '/offers',
              clean({
                branch_id: Array.isArray(input.branch_id)
                  ? undefined
                  : input.branch_id,
                per_page: input.per_page,
              }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/offers/${input.id}`);
          case 'create': {
            require(
              input,
              [
                'name_ar',
                'description_ar',
                'section_id',
                'service_ids',
                'branch_id',
                'price_type',
                'service_price',
              ],
              'create',
            );
            const branches = asArray(input.branch_id);
            if (!branches || branches.length === 0)
              throw new Error('action="create" requires `branch_id` as array.');
            const { discount_percentage, offer_price } = computePricing(
              input.price_type!,
              input.service_price!,
              input.discount_percentage ?? 0,
              input.offer_price ?? 0,
            );
            const payload: Record<string, any> = {
              name_ar: input.name_ar,
              description_ar: input.description_ar,
              section_id: input.section_id,
              service_id: input.service_ids,
              branch_id: branches,
              price_type: input.price_type,
              service_price: input.service_price,
              discount_percentage,
              offer_price,
            };
            if (input.sort !== undefined) payload.sort = input.sort;
            // Home-service opt-in. Mirrors the service umbrella —
            // when the toggle is on, attach the fee + home_hours;
            // when it's off (or omitted) the backend defaults the
            // column to 0 and no home_hours rows are inserted.
            if (input.is_home_service) {
              payload.is_home_service = '1';
              if (input.home_service_fee !== undefined)
                payload.home_service_fee = input.home_service_fee;
              if (input.home_hours && input.home_hours.length > 0)
                payload.home_hours = input.home_hours;
            }
            return api.post('/offers', clean(payload), { multipart: true });
          }
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/offers/${input.id}`);
            const currentServiceIds: any[] = Array.isArray(current.services)
              ? current.services.map((s: any) => s.id ?? s)
              : Array.isArray(current.service_id)
                ? current.service_id
                : [];
            const currentBranchIds: any[] = Array.isArray(current.branches)
              ? current.branches.map((b: any) => b.id ?? b)
              : Array.isArray(current.branch_id)
                ? current.branch_id
                : [];
            const priceType =
              input.price_type ?? (current.price_type as any) ?? 'service';
            const servicePrice =
              input.service_price ??
              Number(current.service_price ?? current.price ?? 0);
            const { discount_percentage, offer_price } = computePricing(
              priceType,
              servicePrice,
              input.discount_percentage ??
                Number(current.discount_percentage ?? 0),
              input.offer_price ?? Number(current.offer_price ?? 0),
            );
            const payload: Record<string, any> = {
              name_ar:
                input.name_ar ?? current.name_ar ?? current.name ?? '',
              description_ar:
                input.description_ar ??
                current.description_ar ??
                current.description ??
                '-',
              section_id:
                input.section_id ??
                current.section?.id ??
                current.section_id,
              service_id:
                input.service_ids && input.service_ids.length > 0
                  ? input.service_ids
                  : currentServiceIds,
              branch_id:
                asArray(input.branch_id) && asArray(input.branch_id)!.length > 0
                  ? asArray(input.branch_id)
                  : currentBranchIds,
              price_type: priceType,
              service_price: servicePrice,
              discount_percentage,
              offer_price,
            };
            if (input.sort !== undefined) payload.sort = input.sort;
            // Home-service round-trip. The Offer model casts
            // is_home_service to boolean, so `current.is_home_service`
            // arrives as a real bool — `Boolean(...)` handles both
            // the cast-to-bool shape and any legacy int 0/1 form.
            // The backend's syncOfferHomeHours is delete-all-then-
            // insert: when staying ON we MUST re-send home_hours
            // (otherwise they get wiped); when flipping OFF we just
            // send is_home_service=0 and the rows disappear.
            const homeOn =
              input.is_home_service !== undefined
                ? input.is_home_service
                : Boolean(current.is_home_service);
            if (homeOn) {
              payload.is_home_service = '1';
              if (input.home_service_fee !== undefined)
                payload.home_service_fee = input.home_service_fee;
              else if (current.home_service_fee !== undefined)
                payload.home_service_fee = current.home_service_fee;
              const hours =
                input.home_hours ??
                (Array.isArray(current.home_hours)
                  ? current.home_hours.map((h: any) => ({
                      day: h.day,
                      start_time: h.start_time,
                      end_time: h.end_time,
                    }))
                  : []);
              if (hours.length > 0) payload.home_hours = hours;
            } else if (input.is_home_service === false) {
              payload.is_home_service = '0';
            }
            return api.putViaPost(`/offers/${input.id}`, payload, {
              multipart: true,
            });
          }
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
        'Manage employees (staff who take bookings).\n\nACTIONS:\n• `list` — list employees. Optional: branch_id, q, per_page.\n• `get` — one employee by id. Required: id.\n• `create` — new employee. Required: first_name, phone, email, branch_id, role_id (from `role action="list"`), official_hours (array of `{day, start_time, end_time}`). Optional: last_name, password (default "12345678"), service_ids, break_hours, bio (May-2026, single multilingual blurb 2-1000 chars), job_title, salary, commission_type (`none`/`fixed`/`percentage`), commission, commission_calculation_method (`gross`/`net`), start_date, end_date (YYYY-MM-DD).\n• `update` — update one. Required: id. All other fields optional — current values echoed when omitted.\n• `activate` / `deactivate` — toggle is_active (hidden from booking pickers when off). Required: id.\n\nThis creates a real user account with login credentials — CONFIRM every field with the vendor.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'update',
          'activate',
          'deactivate',
        ]),
        id: idLike.optional(),
        branch_id: idLike.optional(),
        q: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        first_name: z.string().min(1).optional(),
        last_name: z.string().min(1).optional(),
        phone: z.string().min(7).optional(),
        email: z.string().email().optional(),
        password: z.string().min(8).optional(),
        role_id: idLike.optional(),
        service_ids: z.array(idLike).optional(),
        official_hours: z.array(hourRowSchema).optional(),
        break_hours: z.array(hourRowSchema).optional(),
        bio: z.string().min(2).max(1000).optional(),
        job_title: z.string().optional(),
        salary: z.number().nonnegative().optional(),
        commission_type: z.enum(['none', 'fixed', 'percentage']).optional(),
        commission: z.number().nonnegative().optional(),
        commission_calculation_method: z.enum(['gross', 'net']).optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return api.getRaw(
              '/employees',
              clean({
                branch_id: input.branch_id,
                q: input.q,
                per_page: input.per_page,
              }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/employees/${input.id}`);
          case 'create': {
            require(
              input,
              [
                'first_name',
                'phone',
                'email',
                'branch_id',
                'role_id',
                'official_hours',
              ],
              'create',
            );
            const payload: Record<string, any> = {
              first_name: input.first_name,
              phone: input.phone,
              email: input.email,
              branch_id: input.branch_id,
              role_id: input.role_id,
              official_hours: input.official_hours,
              password: input.password ?? '12345678',
            };
            if (input.last_name) payload.last_name = input.last_name;
            if (input.service_ids && input.service_ids.length > 0)
              payload.service_id = input.service_ids;
            if (input.break_hours && input.break_hours.length > 0)
              payload.break_hours = input.break_hours;
            if (input.bio) payload.bio = input.bio;
            if (input.job_title) payload.job_title = input.job_title;
            if (input.salary !== undefined) payload.salary = input.salary;
            if (input.commission_type)
              payload.commission_type = input.commission_type;
            if (input.commission !== undefined)
              payload.commission = input.commission;
            if (input.commission_calculation_method)
              payload.commission_calculation_method =
                input.commission_calculation_method;
            if (input.start_date) payload.start_date = input.start_date;
            if (input.end_date) payload.end_date = input.end_date;
            return api.post('/employees', payload, { multipart: true });
          }
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/employees/${input.id}`);
            const currentUser = current.user ?? current;
            const currentOfficialHours = Array.isArray(current.official_hours)
              ? current.official_hours.map((h: any) => ({
                  day: h.day,
                  start_time: h.start_time,
                  end_time: h.end_time,
                }))
              : [];
            const currentBreakHours = Array.isArray(current.break_hours)
              ? current.break_hours.map((h: any) => ({
                  day: h.day,
                  start_time: h.start_time,
                  end_time: h.end_time,
                }))
              : [];
            const currentServiceIds = Array.isArray(current.services)
              ? current.services.map((s: any) => s.id ?? s)
              : [];
            const currentBranchId =
              current.branch?.id ??
              current.branch_id ??
              (Array.isArray(current.branches) && current.branches[0]
                ? current.branches[0].id ?? current.branches[0]
                : undefined);
            const payload: Record<string, any> = {
              first_name: input.first_name ?? currentUser.first_name ?? '',
              phone: input.phone ?? currentUser.phone ?? '',
              email: input.email ?? currentUser.email ?? '',
              branch_id: input.branch_id ?? currentBranchId,
              role_id: input.role_id ?? current.role?.id ?? current.role_id,
              official_hours:
                input.official_hours && input.official_hours.length > 0
                  ? input.official_hours
                  : currentOfficialHours,
            };
            if (input.last_name ?? currentUser.last_name)
              payload.last_name = input.last_name ?? currentUser.last_name;
            if (input.service_ids && input.service_ids.length > 0)
              payload.service_id = input.service_ids;
            else if (currentServiceIds.length > 0)
              payload.service_id = currentServiceIds;
            if (input.break_hours && input.break_hours.length > 0)
              payload.break_hours = input.break_hours;
            else if (currentBreakHours.length > 0)
              payload.break_hours = currentBreakHours;
            if (input.bio !== undefined) payload.bio = input.bio;
            else if (current.bio) payload.bio = current.bio;
            if (input.job_title ?? current.job_title)
              payload.job_title = input.job_title ?? current.job_title;
            if (input.salary !== undefined) payload.salary = input.salary;
            else if (current.salary !== undefined && current.salary !== null)
              payload.salary = current.salary;
            if (input.commission_type ?? current.commission_type)
              payload.commission_type =
                input.commission_type ?? current.commission_type;
            if (input.commission !== undefined)
              payload.commission = input.commission;
            else if (current.commission !== undefined && current.commission !== null)
              payload.commission = current.commission;
            if (
              input.commission_calculation_method ??
              current.commission_calculation_method
            )
              payload.commission_calculation_method =
                input.commission_calculation_method ??
                current.commission_calculation_method;
            if (input.start_date ?? current.start_date)
              payload.start_date = input.start_date ?? current.start_date;
            if (input.end_date ?? current.end_date)
              payload.end_date = input.end_date ?? current.end_date;
            return api.putViaPost(`/employees/${input.id}`, payload, {
              multipart: true,
            });
          }
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/employees/${input.id}/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — employee_portfolio
    // ════════════════════════════════════════════════════════════════

    {
      name: 'employee_portfolio',
      description:
        'Manage an employee\'s portfolio gallery (May-2026). Image UPLOAD is NOT exposed (binary uploads don\'t fit MCP\'s text channel) — vendors upload through the dashboard, but everything else is here.\n\nACTIONS:\n• `sort` — bulk reorder. Required: employee_id, items (array of `{id, sort}`). Lower sort = top.\n• `activate` / `deactivate` — toggle visibility on the customer-facing employee profile. Required: employee_id, image_id.',
      inputSchema: z.object({
        action: z.enum(['sort', 'activate', 'deactivate']),
        employee_id: idLike,
        image_id: idLike.optional(),
        items: z
          .array(z.object({ id: idLike, sort: z.number().int().min(0) }))
          .min(1)
          .optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'sort':
            require(input, ['items'], 'sort');
            return api.post(
              `/employees/${input.employee_id}/portfolio/sort`,
              { items: input.items },
              { multipart: true },
            );
          case 'activate':
          case 'deactivate':
            require(input, ['image_id'], input.action);
            return api.post(
              `/employees/${input.employee_id}/portfolio/${input.image_id}/${input.action}`,
            );
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — customer
    // ════════════════════════════════════════════════════════════════

    {
      name: 'customer',
      description:
        'Manage customers (the vendor\'s customer roster).\n\nACTIONS:\n• `list` — search the roster. Optional: q (matches name + phone with or without +966), per_page. Returns user table rows tagged type=customer.\n• `get` — one customer by id. Required: id.\n• `create` — new customer. Required: first_name, phone (digits only). Optional: last_name, email. Backend auto-links to an existing User row if phone/email exists.\n\nNote: customer ids in the response are User table ids — pass them to `booking action="create"` as `customer_id`.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'create']),
        id: idLike.optional(),
        q: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        first_name: z.string().min(1).optional(),
        last_name: z.string().optional(),
        phone: z
          .string()
          .optional()
          .describe('Digits only (e.g. "0501234567"). Strip + and country code first.'),
        email: z.string().email().optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return api.getRaw(
              '/customers',
              clean({ q: input.q, per_page: input.per_page }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/customers/${input.id}`);
          case 'create':
            require(input, ['first_name', 'phone'], 'create');
            // /customers POST is JSON not multipart — the one endpoint
            // that diverges from the standard write pattern.
            return api.post(
              '/customers',
              clean({
                first_name: input.first_name,
                last_name: input.last_name,
                phone: input.phone,
                email: input.email,
              }),
            );
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — review (May-2026 reviews refactor)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'review',
      description:
        'Read customer reviews on this vendor\'s bookings (May-2026 refactor: `employee_rate` 1-5 is the canonical rating column; `service_rate` was deprecated and dropped).\n\nACTIONS:\n• `list` — paginated reviews. Filters: branch_id, employee_id, rating (1-5), from/to (YYYY-MM-DD on start_time), page, per_page. Returns paginated rows PLUS a `summary` block with `{ average, count, breakdown: {1..5: n} }`.\n• `get` — one review by id. Required: id.\n\nNo write actions — moderation happens through the admin surface.',
      inputSchema: z.object({
        action: z.enum(['list', 'get']),
        id: idLike.optional(),
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
        rating: z.union([z.number().int().min(1).max(5), z.string()]).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return api.getRaw(
              '/reviews',
              clean({
                branch_id: input.branch_id,
                employee_id: input.employee_id,
                rating: input.rating,
                from: input.from,
                to: input.to,
                page: input.page,
                per_page: input.per_page,
              }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/reviews/${input.id}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — invoice
    // ════════════════════════════════════════════════════════════════

    {
      name: 'invoice',
      description:
        'Read ZATCA-issued tax invoices.\n\nACTIONS:\n• `list` — paginated invoices. Optional: branch_id, per_page, page.\n• `get` — one invoice by id. Required: id.\n\nOnly meaningful for ZATCA-active vendors — non-ZATCA vendors don\'t generate invoices.',
      inputSchema: z.object({
        action: z.enum(['list', 'get']),
        id: idLike.optional(),
        branch_id: idLike.optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return api.getRaw(
              '/invoices',
              clean({
                branch_id: input.branch_id,
                page: input.page,
                per_page: input.per_page,
              }),
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
        'Manage the vendor\'s curated cancellation reasons — the picker shown to customers when they cancel a booking (May-2026).\n\nACTIONS:\n• `list` — list reasons. Optional: q, page, per_page, skip_seed (default false — first visit auto-seeds a default set).\n• `get` — one reason by id. Required: id.\n• `create` — new reason. Required: reason_ar (2-500 chars). Optional: reason_en (2-500), sort (0-127).\n• `update` — update text/sort. Required: id. Optional: reason_ar, reason_en, sort.\n• `activate` / `deactivate` — toggle picker visibility. Required: id.\n• `sort` — bulk reorder. Required: items (array of `{id, sort}`). Lower sort = top of picker.\n\nThe vendor\'s reasons appear ALONGSIDE the admin-managed globals on the customer cancel modal; both pickers union into one list.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'update',
          'activate',
          'deactivate',
          'sort',
        ]),
        id: idLike.optional(),
        reason_ar: z.string().min(2).max(500).optional(),
        reason_en: z.string().min(2).max(500).optional(),
        sort: z.number().int().min(0).max(127).optional(),
        q: z.string().optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        skip_seed: z.boolean().optional(),
        items: z
          .array(
            z.object({ id: idLike, sort: z.number().int().min(0).max(127) }),
          )
          .min(1)
          .optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return api.getRaw(
              '/cancellation-reasons',
              clean({
                q: input.q,
                page: input.page,
                per_page: input.per_page,
                skip_seed: input.skip_seed ? '1' : undefined,
              }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/cancellation-reasons/${input.id}`);
          case 'create':
            require(input, ['reason_ar'], 'create');
            return api.post(
              '/cancellation-reasons',
              clean({
                reason_ar: input.reason_ar,
                reason_en: input.reason_en,
                sort: input.sort,
              }),
              { multipart: true },
            );
          case 'update': {
            require(input, ['id'], 'update');
            const payload: Record<string, any> = {};
            if (input.reason_ar) payload.reason_ar = input.reason_ar;
            if (input.reason_en) payload.reason_en = input.reason_en;
            if (input.sort !== undefined) payload.sort = input.sort;
            return api.putViaPost(
              `/cancellation-reasons/${input.id}`,
              payload,
              { multipart: true },
            );
          }
          case 'activate':
          case 'deactivate':
            require(input, ['id'], input.action);
            return api.post(`/cancellation-reasons/${input.id}/${input.action}`);
          case 'sort':
            require(input, ['items'], 'sort');
            return api.post(
              '/cancellation-reasons/sort',
              { items: input.items },
              { multipart: true },
            );
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — promo_code
    // ════════════════════════════════════════════════════════════════

    {
      name: 'promo_code',
      description:
        'Manage vendor-owned promo codes.\n\nACTIONS:\n• `list` — paginated list.\n• `get` — one by id. Required: id.\n• `create` — new code. Required: discount_type (`percentage`/`fixed`), value (≥0), start_date, end_date (YYYY-MM-DD, end > start), uses (≥1). Optional: code (alphanumeric ASCII ≥5; auto-generated if omitted).\n• `update` — update one. Required: id. All other fields optional.\n• `activate` / `deactivate` — toggle is_active. Required: id.\n\nValue semantics: when discount_type=percentage, value is 0-100. When discount_type=fixed, value is SAR.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'update',
          'activate',
          'deactivate',
        ]),
        id: idLike.optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        code: z
          .string()
          .min(5)
          .regex(/^[A-Za-z0-9]+$/, 'Alphanumeric ASCII only.')
          .optional(),
        discount_type: z.enum(['percentage', 'fixed']).optional(),
        value: z.number().nonnegative().optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        uses: z.number().int().min(1).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return api.getRaw(
              '/promo-codes',
              clean({ page: input.page, per_page: input.per_page }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/promo-codes/${input.id}`);
          case 'create':
            require(
              input,
              ['discount_type', 'value', 'start_date', 'end_date', 'uses'],
              'create',
            );
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
            require(input, ['id'], 'update');
            const current = await api.get(`/promo-codes/${input.id}`);
            const payload: Record<string, any> = {
              discount_type: input.discount_type ?? current.discount_type,
              value: input.value ?? current.value,
              start_date: input.start_date ?? current.start_date,
              end_date: input.end_date ?? current.end_date,
              uses: input.uses ?? current.uses,
            };
            if (input.code) payload.code = input.code;
            return api.putViaPost(`/promo-codes/${input.id}`, payload, {
              multipart: true,
            });
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
        'Manage vendor-scoped roles (assigned to employees via `employee action="create"`).\n\nACTIONS:\n• `list` — paginated list.\n• `get` — one by id. Required: id.\n• `create` — new role. Required: name, permissions (array of permission name strings — pull from `list_permissions`).\n• `update` — update one. Required: id. Optional: name, permissions.\n• `activate` / `deactivate` — toggle. Required: id.',
      inputSchema: z.object({
        action: z.enum([
          'list',
          'get',
          'create',
          'update',
          'activate',
          'deactivate',
        ]),
        id: idLike.optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        name: z.string().min(2).optional(),
        permissions: z.array(z.string()).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return api.getRaw(
              '/roles',
              clean({ page: input.page, per_page: input.per_page }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/roles/${input.id}`);
          case 'create':
            require(input, ['name', 'permissions'], 'create');
            return api.post(
              '/roles',
              { name: input.name, permissions: input.permissions },
              { multipart: true },
            );
          case 'update': {
            require(input, ['id'], 'update');
            const current = await api.get(`/roles/${input.id}`);
            const currentPermissions: string[] = Array.isArray(current.permissions)
              ? current.permissions.map((p: any) =>
                  typeof p === 'string' ? p : p.name,
                )
              : [];
            return api.putViaPost(
              `/roles/${input.id}`,
              {
                name: input.name ?? current.name ?? '',
                permissions:
                  input.permissions && input.permissions.length > 0
                    ? input.permissions
                    : currentPermissions,
              },
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
        'Manage booking reminders (when to remind customers before their booking — e.g. 24h before, 1h before).\n\nACTIONS:\n• `list` — list reminders.\n• `get` — one by id. Required: id.\n• `update` — update one. Required: id. Optional: minutes_before, channels (array of reminder-channel ids).\n• `activate` / `deactivate` — toggle. Required: id.',
      inputSchema: z.object({
        action: z.enum(['list', 'get', 'update', 'activate', 'deactivate']),
        id: idLike.optional(),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        minutes_before: z.number().int().min(0).optional(),
        channels: z.array(idLike).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'list':
            return api.getRaw(
              '/reminders',
              clean({ page: input.page, per_page: input.per_page }),
            );
          case 'get':
            require(input, ['id'], 'get');
            return api.get(`/reminders/${input.id}`);
          case 'update': {
            require(input, ['id'], 'update');
            const payload: Record<string, any> = {};
            if (input.minutes_before !== undefined)
              payload.minutes_before = input.minutes_before;
            if (input.channels) payload.channels = input.channels;
            return api.putViaPost(`/reminders/${input.id}`, payload, {
              multipart: true,
            });
          }
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
        'Manage which delivery channels (SMS / Email / Push / WhatsApp) are enabled for booking reminders.\n\nACTIONS:\n• `get` — read the current channel list with their enabled flags.\n• `update` — toggle channels. Required: channels (array of `{id, is_active}`).',
      inputSchema: z.object({
        action: z.enum(['get', 'update']),
        channels: z
          .array(z.object({ id: idLike, is_active: z.boolean() }))
          .min(1)
          .optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'get':
            return api.get('/reminder-channels');
          case 'update': {
            require(input, ['channels'], 'update');
            const payload = {
              channels: (
                input.channels as Array<{ id: any; is_active: boolean }>
              ).map((c) => ({ id: c.id, is_active: bool01(c.is_active) })),
            };
            return api.putViaPost('/reminder-channels', payload, {
              multipart: true,
            });
          }
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — settings
    // ════════════════════════════════════════════════════════════════

    {
      name: 'settings',
      description:
        'Read/write the vendor\'s storefront settings.\n\nACTIONS:\n• `get` — current settings.\n• `update` — change settings. Optional fields (current values echoed when omitted): booking_differance (minutes of lead time before customers can book, ≥0), calender_differance (calendar resolution, 5-30 min), cancel_booking (whether customers can self-cancel), reviews_enabled (toggle customer review CTA + vendor dashboard), terms (T&C blurb, ≥3 chars).',
      inputSchema: z.object({
        action: z.enum(['get', 'update']),
        booking_differance: z.number().int().min(0).optional(),
        calender_differance: z.number().int().min(5).max(30).optional(),
        cancel_booking: z.boolean().optional(),
        reviews_enabled: z.boolean().optional(),
        terms: z.string().min(3).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'get':
            return api.get('/settings');
          case 'update': {
            const current = await api.get('/settings');
            const payload: Record<string, any> = {
              booking_differance:
                input.booking_differance ?? current.booking_differance ?? 0,
              calender_differance:
                input.calender_differance ?? current.calender_differance ?? 15,
              cancel_booking:
                input.cancel_booking !== undefined
                  ? bool01(input.cancel_booking)
                  : current.cancel_booking,
            };
            if (input.reviews_enabled !== undefined)
              payload.reviews_enabled = bool01(input.reviews_enabled);
            else if (current.reviews_enabled !== undefined)
              payload.reviews_enabled = current.reviews_enabled;
            if (input.terms) payload.terms = input.terms;
            else if (current.terms) payload.terms = current.terms;
            return api.putViaPost('/settings', payload, { multipart: true });
          }
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — zatca
    // ════════════════════════════════════════════════════════════════

    {
      name: 'zatca',
      description:
        'Manage ZATCA (Saudi tax authority) integration.\n\nACTIONS:\n• `get` — registration status (`registered`, `active`, seller info). The vendor is "ZATCA-active" (issues real tax invoices) only when BOTH registered=1 AND active=1.\n• `update` — update seller metadata. Required: seller_name_en, seller_name_ar, tax_number, address.\n• `register` — register with ZATCA. Required: environment (`sandbox`/`production`), otp (6 digits from the ZATCA Fatoora portal). One-time onboarding step — registering in production is IRREVERSIBLE. CONFIRM with extreme care.\n• `activate` / `deactivate` — toggle phase-2 (real tax invoice issuance) on/off.',
      inputSchema: z.object({
        action: z.enum([
          'get',
          'update',
          'register',
          'activate',
          'deactivate',
        ]),
        seller_name_en: z.string().min(2).optional(),
        seller_name_ar: z.string().min(2).optional(),
        tax_number: z.union([z.string(), z.number()]).optional(),
        address: z.string().min(2).optional(),
        environment: z.enum(['sandbox', 'production']).optional(),
        otp: z.string().regex(/^\d{6}$/).optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'get':
            return api.get('/zatca');
          case 'update':
            require(
              input,
              ['seller_name_en', 'seller_name_ar', 'tax_number', 'address'],
              'update',
            );
            return api.putViaPost(
              '/zatca',
              {
                seller_name_en: input.seller_name_en,
                seller_name_ar: input.seller_name_ar,
                tax_number: input.tax_number,
                address: input.address,
              },
              { multipart: true },
            );
          case 'register':
            require(input, ['environment', 'otp'], 'register');
            return api.post(
              '/zatca/register',
              { environment: input.environment, otp: input.otp },
              { multipart: true },
            );
          case 'activate':
          case 'deactivate':
            return api.post(`/zatca/${input.action}`);
        }
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  UMBRELLA — account
    // ════════════════════════════════════════════════════════════════

    {
      name: 'account',
      description:
        'Manage the vendor account (changes that aren\'t covered by `get_profile`).\n\nACTIONS:\n• `change_password` — Required: current_password, new_password (≥8). Optional: new_password_confirmation (defaults to new_password).\n• `send_code` — request a 6-digit verification code (used before update_email / update_phone). Backend picks the delivery channel.\n• `update_email` — Required: email (valid format), code (6 digits from send_code).\n• `update_phone` — Required: phone (digits only, no + prefix), code (6 digits).\n• `update_profile` — change non-sensitive fields. Optional: name, first_name, last_name, bio, instagram_url, twitter_url, snapchat_url, tiktok_url, website_url.\n\nCONFIRM every account-touching action with the vendor before invoking.',
      inputSchema: z.object({
        action: z.enum([
          'change_password',
          'send_code',
          'update_email',
          'update_phone',
          'update_profile',
        ]),
        current_password: z.string().optional(),
        new_password: z.string().min(8).optional(),
        new_password_confirmation: z.string().min(8).optional(),
        email: z.string().email().optional(),
        phone: z.string().min(7).optional(),
        code: z.string().regex(/^\d{6}$/).optional(),
        name: z.string().min(2).optional(),
        first_name: z.string().min(2).optional(),
        last_name: z.string().min(2).optional(),
        bio: z.string().optional(),
        instagram_url: z.string().url().optional(),
        twitter_url: z.string().url().optional(),
        snapchat_url: z.string().url().optional(),
        tiktok_url: z.string().url().optional(),
        website_url: z.string().url().optional(),
      }),
      handler: async (input) => {
        switch (input.action) {
          case 'change_password':
            require(input, ['current_password', 'new_password'], 'change_password');
            return api.post(
              '/change-password',
              {
                current_password: input.current_password,
                new_password: input.new_password,
                new_password_confirmation:
                  input.new_password_confirmation ?? input.new_password,
              },
              { multipart: true },
            );
          case 'send_code':
            return api.post('/send-code');
          case 'update_email':
            require(input, ['email', 'code'], 'update_email');
            return api.post(
              '/update-email',
              { email: input.email, code: input.code },
              { multipart: true },
            );
          case 'update_phone':
            require(input, ['phone', 'code'], 'update_phone');
            return api.post(
              '/update-phone',
              { phone: input.phone, code: input.code },
              { multipart: true },
            );
          case 'update_profile':
            return api.post(
              '/update-profile',
              clean({
                name: input.name,
                first_name: input.first_name,
                last_name: input.last_name,
                bio: input.bio,
                instagram_url: input.instagram_url,
                twitter_url: input.twitter_url,
                snapchat_url: input.snapchat_url,
                tiktok_url: input.tiktok_url,
                website_url: input.website_url,
              }),
              { multipart: true },
            );
        }
      },
    },
  ];
}
