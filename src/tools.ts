/**
 * Tool definitions for the Streamline MCP server.
 *
 * Each tool is a thin wrapper over one or two `vendorApi` calls. The
 * surface deliberately mirrors the mobile app's endpoint helpers
 * (`src/api/endpoints/*.ts`) so anyone who knows the mobile codebase
 * can find the same name here — `list_bookings` maps to the same
 * `/bookings` index call, `get_reports` to `/reports?type=home`, etc.
 *
 * Tool descriptions matter A LOT. The Claude model picks tools by
 * reading these strings, so they have to be concrete about WHEN to
 * use the tool, WHAT it returns, and any quirks the caller needs to
 * know (e.g. "phone is matched even when prefixed with +966").
 *
 * Surface (v0.5):
 *   • Phase A — every existing tool re-aligned with the May-2026
 *     backend (offer_ids on bookings, cancellation_reason on cancel,
 *     official_hours on employees, fixed offer/service field names,
 *     dropped dummy_*_en placeholders, expanded reports types +
 *     periods).
 *   • Phase B — reviews, invoices, POS preview, settings, promo
 *     codes, vendor-managed cancellation reasons.
 *   • Phase C — full CRUD MINUS delete on branches / sections /
 *     services / offers / employees / portfolio / zatca / roles /
 *     permissions.
 *   • Phase D — reminders, reminder channels, account management.
 *
 * DELETE OPERATIONS ARE INTENTIONALLY NOT EXPOSED.
 * Per vendor instruction (May-2026): "بس لا تسمح للـ mcp يقدر يسوي
 * delete، الباقي كل شيء عادي". So:
 *   • Bookings → cancel_booking + mark_no_show + complete_booking
 *     are the terminal states. No DELETE /bookings/{id} tool.
 *   • Services / Sections / Branches / Offers / Employees / Roles /
 *     PromoCodes / CancellationReasons → activate/deactivate is the
 *     soft-hide. No destructive DELETE.
 *   • Portfolio images → activate/deactivate only.
 *
 * Backward compatibility (Phase-1 stdio + DXT):
 *   • All existing tool names are preserved.
 *   • Inputs that were valid before are still valid (new fields are
 *     OPTIONAL).
 *   • Existing comments referencing the customer-side bug for the
 *     walk-in sentinel + the ZATCA strip + the completed guard are
 *     preserved verbatim because those rules still hold.
 */
import { z } from 'zod';
import { VendorClient } from './vendor-client.js';
import { nowSaudi, saudiLocalToUnix } from './time.js';

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
 * misses). Booleans are kept as-is; downstream Axios serializes them.
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
 * from anything to anything — it doesn't itself block a completed
 * booking from being cancelled or rescheduled. That's intentional on
 * the backend (admin tooling sometimes needs to retro-fix records) but
 * for vendor conversations through Claude it's a footgun: a completed
 * booking has an issued invoice and balanced wallet transactions, and
 * any status flip after that desyncs reports and tax records.
 *
 * Per user instruction: completed bookings are FINAL — block at this
 * layer. Notes-only edits are NOT blocked because they're metadata
 * and don't touch the financial side.
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
 * response. Backend shapes we observe:
 *   • `booking.user` / `booking.user_id` — set when a real
 *      customer was attached; null for walk-in.
 *   • `booking.customer` — a NORMALISED object the resource always
 *      returns. For walk-in bookings the backend sends a SENTINEL
 *      placeholder: `{ id: 0, name: "عميل تلقائي" }`. This is the
 *      bug that bit us: id=0 is not a real users.id, and naively
 *      reading it caused our PUT to send `customer_id=0`, which the
 *      `exists:users,id` validator rejects with "الحقل customer id
 *      لاغٍ" ("customer id field is invalid").
 *
 * Rule: only return an id that's a STRICTLY POSITIVE INTEGER. Any
 * other shape (null, undefined, 0, NaN, negative) means "walk-in,
 * keep customer_id off the wire". The caller relies on `clean()` to
 * drop null values from the FormData, so the field disappears
 * rather than being submitted as null/"null"/0.
 */
function existingCustomerId(detail: any): number | null {
  const candidate =
    detail?.user?.id ??
    detail?.user_id ??
    detail?.customer?.id ??
    null;
  const n = Number(candidate);
  // Strict > 0: a positive integer means we have a real customer
  // user row to round-trip. Anything else (NaN, 0, negative,
  // null-coerced-to-0) is the walk-in sentinel and we DROP it.
  if (Number.isFinite(n) && n > 0) return n;
  return null;
}

/**
 * Pull the service_ids + offer_ids off a booking detail so a round-trip
 * PUT (cancel / complete / no-show / notes) preserves them.
 *
 * Why both — bookings may carry EITHER service_ids OR offer_ids (the
 * BookingRequest accepts `required_without` on each). When the
 * original booking was created from an offer, the booking_items
 * rows expose `offer_id` set + `service_id` reflecting the underlying
 * service. If we only echo `service_ids` on the PUT, the backend
 * recomputes pricing from the underlying services and the offer
 * discount silently disappears from the total. Preserving offer_ids
 * keeps the offer association — and the discounted total — intact.
 *
 * Edge cases:
 *   • Mixed booking_items (some with offer_id, some without) are
 *     real — a vendor can attach an offer + ad-hoc service in one
 *     booking. We dedupe both arrays so we don't double-count.
 *   • A walk-in / POS booking has `bookingService` rather than
 *     `booking_items` on some response shapes; we try both.
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
      if (offerId != null) {
        offerIds.add(offerId);
      } else if (serviceId != null) {
        serviceIds.add(serviceId);
      }
    });
  }
  return {
    service_ids: Array.from(serviceIds),
    offer_ids: Array.from(offerIds),
  };
}

/**
 * Strip VAT / tax fields from a booking object when the vendor is
 * NOT ZATCA-active.
 *
 * Why: the backend's `BookingService::create` ALWAYS pre-computes
 * a 15% VAT into `vat` / `total_vat` / per-line `vat` fields, even
 * when the vendor has no ZATCA record. That's a bug-shaped feature
 * — the mobile app handles it by hiding the VAT row from the UI
 * via `useZatcaActive` (see mobile/src/hooks/useZatcaActive.ts).
 * Here we apply the same gate: when ZATCA isn't active, the VAT
 * numbers must never reach the conversation, because the model
 * would otherwise tell the vendor "you collected X SAR tax" — which
 * is wrong, no invoice was issued.
 *
 * We delete top-level and nested per-line VAT keys IN PLACE on a
 * deep-cloned copy so the original cache is untouched.
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
  // Per-line VAT on booking_items / booking_services.
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

/**
 * Shared zod fragment for "either a numeric or string id" — the
 * backend accepts both shapes for route params and FK fields, and
 * callers occasionally pass through a string from JSON without
 * casting.
 */
const idLike = z.union([z.number(), z.string()]);

/**
 * Shared zod schema for an `official_hours` / `break_hours` array.
 *
 * Backend rule (EmployeeRequest, BranchRequest):
 *   • day      — one of: sat sun mon tue wed thu fri
 *   • start_time — HH:MM 24h
 *   • end_time   — HH:MM 24h
 *
 * For break_hours all three are nullable per the validator but the
 * MCP layer requires the trio together since a partial row would
 * fail downstream validation anyway.
 */
const dayEnum = z.enum(['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri']);
const hourPattern = /^\d{1,2}:\d{2}$/;
const officialHourSchema = z.object({
  day: dayEnum,
  start_time: z
    .string()
    .regex(hourPattern, 'HH:MM (24-hour) e.g. "09:00"'),
  end_time: z
    .string()
    .regex(hourPattern, 'HH:MM (24-hour) e.g. "21:00"'),
});

/**
 * `home_hours` is structurally identical to official_hours — kept as
 * an alias so each tool's schema stays self-documenting.
 */
const homeHourSchema = officialHourSchema;

/**
 * Convert MCP's `false/true` boolean to Laravel's `'0'/'1'` string
 * form that the backend's FormRequest validators (`in:0,1`) accept.
 */
function bool01(v: boolean | undefined): '0' | '1' | undefined {
  if (v === undefined) return undefined;
  return v ? '1' : '0';
}

// ════════════════════════════════════════════════════════════════════
//  TOOL BUILDER
// ════════════════════════════════════════════════════════════════════

export function buildTools(api: VendorClient): ToolDef[] {
  return [
    // ════════════════════════════════════════════════════════════════
    //  READ — account + reference data
    // ════════════════════════════════════════════════════════════════

    {
      name: 'get_profile',
      description:
        'Get the logged-in vendor account profile: name, email, phone, role, active subscription summary, and social links. Use this first when the user asks "who am I" / "what plan am I on" / "what\'s my account info".\n\n**GLOBAL CONVENTIONS FOR ALL TOOLS IN THIS SERVER:**\n• **Timezone:** the vendor operates in Saudi Arabia (Asia/Riyadh, UTC+3, no DST). When the user says "today" / "tomorrow" / "this evening" / "اليوم" / "بكره" they mean Saudi-local. NEVER guess or compute unix timestamps in your head — first call `get_current_time` to get the actual Saudi date, then pass `local_datetime` (YYYY-MM-DD HH:MM Saudi local) to booking tools and let the server convert. Manual timestamp math has already created off-by-a-week bugs.\n• **Numeric ids** (id, branch_id, employee_id, service_id, customer_id, user_id, etc.) are for YOUR follow-up tool calls only. Never include them in your reply to the user. Refer to entities by their human-readable names ("سمير" not "سمير id=10", "حلاق النخيل" not "branch 3", "حلاقة شعر للأطفال" not "service id=22").\n• **VAT / tax** numbers (vat, total_vat, tax) are stripped from booking responses when the vendor is not ZATCA-active. If a booking response has no VAT fields, the vendor cannot issue tax invoices — do not invent, mention, or compute tax in your reply.\n• **DELETE is intentionally not exposed.** This MCP cannot delete bookings / services / employees / branches / offers / promo codes / sections / roles. If the user asks to "delete" something, suggest deactivation instead (most resources have an activate/deactivate pair which removes them from customer-facing surfaces without losing historical data).\n• **Arabic-first:** all `name_*` fields default to Arabic. The `_en` columns are nullable in the backend and are NOT used by this MCP — never send English placeholders.',
      inputSchema: z.object({}),
      handler: async () => {
        return api.get('/profile');
      },
    },

    {
      name: 'get_current_time',
      description:
        'Returns the current date and time in **Saudi local timezone (Asia/Riyadh, UTC+3)**. The Streamline vendor lives in Saudi Arabia and all "today" / "tomorrow" / "now" references are relative to this. Use this BEFORE every booking-related write so you know what "today" actually is — the model has no reliable internal clock and previously computed wrong dates (off by days) when guessing timestamps.\n\nResponse includes:\n• `date` (YYYY-MM-DD, Saudi)\n• `time` (HH:MM 24h, Saudi)\n• `weekday_ar` (e.g. "السبت")\n• `human` (formatted display string)\n• `unix_seconds` (absolute Unix time — same value globally)\n\nUse the `date` field with the booking tools\' `local_datetime` parameter rather than computing unix timestamps yourself.',
      inputSchema: z.object({}),
      handler: async () => {
        return nowSaudi();
      },
    },

    {
      name: 'list_branches',
      description:
        'List the vendor\'s branches. Returns every branch with id, name (Arabic), address, lat/long, active flag, and official_hours. Use this when the user asks about branches, locations, or before any other tool that needs a branch_id — call this first so you can map a friendly name like "حلاق النخيل" to its numeric id.\n\n**The numeric ids in the response are for YOUR follow-up tool calls — do NOT show them to the user. Refer to branches by name only when replying to the human ("حلاق النخيل" not "branch id 3").**',
      inputSchema: z.object({
        without_pagination: z
          .boolean()
          .optional()
          .describe(
            'Set true to get all branches in one response (recommended for picking by name).',
          ),
      }),
      handler: async ({ without_pagination }) => {
        return api.get(
          '/branches',
          clean({
            without_pagination: without_pagination ? 'true' : undefined,
          }),
        );
      },
    },

    {
      name: 'get_branch',
      description:
        'Get full detail for one branch including official_hours per weekday, gallery, manager, lat/long. Use when the user asks about working hours or before scheduling a booking to know the open window.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        return api.get(`/branches/${id}`);
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — bookings & calendar
    // ════════════════════════════════════════════════════════════════

    {
      name: 'list_bookings',
      description:
        'List bookings. Supports filtering by branch_id, employee_id, status (`confirmed`, `completed`, `canceled`, `missed`, `not_confirmed`), and a specific date (YYYY-MM-DD — matched against `start_time`). Returns paginated bookings with customer name, services, employee, time, status, payment, and total. Use this for "show me today\'s bookings", "what bookings does ahmad have this week", "any canceled bookings in فرع النخيل".\n\n**Do NOT mention internal id fields (id, employee_id, branch_id, etc.) to the user in your replies — they are implementation details. Use the human-readable names (customer name, employee name, branch name, time).**\n\n**VAT fields (vat, total_vat, tax) are AUTOMATICALLY STRIPPED from the response when the vendor is not ZATCA-active. If you don\'t see VAT fields, the vendor has no tax invoices — don\'t invent or display tax numbers.**',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
        status: z
          .enum(['confirmed', 'completed', 'canceled', 'missed', 'not_confirmed'])
          .optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD. Backend matches against booking start_time.'),
        q: z
          .string()
          .optional()
          .describe('Free-text search (customer name / id).'),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        const [res, zatca] = await Promise.all([
          api.getRaw('/bookings', clean(input)),
          api.getZatcaState(),
        ]);
        if (zatca.active) return res;
        // Strip VAT from each item in the paginated wrapper.
        const items = res?.data?.data ?? res?.data ?? res;
        if (Array.isArray(items)) {
          const stripped = items.map((b) => stripVatFields(b));
          if (res?.data?.data) {
            return { ...res, data: { ...res.data, data: stripped } };
          }
          if (res?.data) return { ...res, data: stripped };
          return stripped;
        }
        return res;
      },
    },

    {
      name: 'get_booking',
      description:
        'Get full detail for a single booking by id: customer, services (with per-line price + commission), employee, branch, status, payment, total, promo code applied, notes, full status update history (timeline of who changed what when), AND — when the booking was cancelled — the cancellation reason (free-text + picked-from-list). Use this when the user references a specific booking number or you need to know who served which booking.\n\n**Do NOT mention internal id fields (id, employee_id, branch_id, etc.) to the user in your replies — they are implementation details. Use the human-readable names (customer name, employee name, branch name, time).**\n\n**VAT fields (vat, total_vat, tax) are AUTOMATICALLY STRIPPED from the response when the vendor is not ZATCA-active. The backend pre-computes VAT for every booking regardless of ZATCA status, but those numbers are meaningless when no tax invoice was issued. If the response has no VAT keys, the vendor is in non-VAT mode — do not invent, display, or sum VAT in your reply to the user.**\n\nCancellation context (May-2026):\n• `cancellation_reason` — the free-text reason or "Other" label.\n• `cancel_reason` — { id, reason_ar, reason_en } when the cancel went through the picker (vendor- or customer-curated list).\n• `canceled_by` — who initiated the cancel (user id; cross-reference with list_customers / list_employees if you need the name).\n• `review` — the customer\'s post-booking rating object when present (employee_rate + employee_comment + created_at).',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        const [booking, zatca] = await Promise.all([
          api.get(`/bookings/${id}`),
          api.getZatcaState(),
        ]);
        return zatca.active ? booking : stripVatFields(booking);
      },
    },

    {
      name: 'get_calendar',
      description:
        'Day-view list of bookings for a specific date + branch. Returns the same shape as list_bookings but the backend already filters to one day server-side, so it\'s the right tool when the user says "اعرض جدول اليوم" or "show me the calendar for tomorrow". `date` is YYYY-MM-DD. Optional employee_id filter narrows to one staff member.',
      inputSchema: z.object({
        branch_id: idLike,
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('YYYY-MM-DD.'),
        employee_id: idLike.optional(),
      }),
      handler: async (input) => {
        // /calendar is POST (not GET) per the backend route file.
        return api.post('/calendar', clean(input), { multipart: true });
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — catalog (services / sections / employees / customers)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'list_services',
      description:
        'List services in the vendor\'s catalog. Optional filters: branch_id, section_id, is_active, free-text q. Returns id, name_ar, price, service_time (minutes), discount, featured flag, sections, branches, home_service fields (is_home_service, home_service_fee, home_hours). Use this before update_service so you have the service id, or whenever the user asks about pricing / what services exist.\n\n**The numeric ids in the response are for YOUR follow-up tool calls — never include them in your reply to the user. Refer to services by name only.**',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        section_id: idLike.optional(),
        is_active: z.enum(['0', '1']).optional(),
        q: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/services', clean(input));
      },
    },

    {
      name: 'list_sections',
      description:
        'List service sections (the groupings shown above the services tab in the app: "قسم شعر", "قسم لحية", etc.). Each section carries an id + name_ar and its nested services. Defaults to without_pagination=true so the caller gets the full list back in one shot — that\'s what create_service / catalog flows need. Pass without_pagination=false for the paginated index.',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        without_pagination: z.boolean().optional(),
      }),
      handler: async ({ branch_id, without_pagination }) => {
        // /sections is the list endpoint; `?without_pagination=true`
        // flattens it. There is NO /sections/all route — that path
        // gets parsed as `GET /sections/{section}` with `section=all`
        // and the route-model-binding fails with 404 (verified the
        // hard way against the live API).
        const params: Record<string, any> = {};
        if (without_pagination !== false) params.without_pagination = 'true';
        if (branch_id) params.branch_id = branch_id;
        return api.getRaw('/sections', params);
      },
    },

    {
      name: 'list_employees',
      description:
        'List employees with branches, job title, services count, bookings count, bio. Optional filters: branch_id, q. Use this when the user mentions an employee by name to map it to an employee id, or to answer "كم موظف عندي / how many staff do I have".\n\n**The numeric ids in the response are for YOUR follow-up tool calls — never include them in your reply to the user. Refer to employees by name only (e.g. "سمير" not "سمير (id=10)").**',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        q: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/employees', clean(input));
      },
    },

    {
      name: 'get_employee',
      description:
        'Get full detail for one employee — branches, services they perform, official_hours, break_hours, salary, commission setup, bio, portfolio gallery. Use before update_employee or to answer "what services does سمير do" / "what hours does سمير work".',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        return api.get(`/employees/${id}`);
      },
    },

    {
      name: 'list_customers',
      description:
        'Search the vendor\'s customer roster. Returns id, first_name, last_name, phone, email, bookings_count. The `q` param matches against name and phone (with or without +966 prefix). Use for "find customer ahmad" / "who is the phone 0501234567".\n\n**The numeric ids in the response are for YOUR follow-up tool calls — never expose them in your reply to the user. Refer to customers by name and (when relevant) phone, never by id.**',
      inputSchema: z.object({
        q: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/customers', clean(input));
      },
    },

    {
      name: 'get_customer',
      description:
        'Get full customer detail by id — name, contact info, total bookings, last visit, branches visited. Use when the user references a specific customer by id or after list_customers to drill down.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        return api.get(`/customers/${id}`);
      },
    },

    {
      name: 'list_offers',
      description:
        'List promotional offers in the vendor\'s catalog. Each has name_ar, services, price_type ("service"/"free"/"discount"/"special"), offer_price, discount %, validity window, is_active. Use before create_offer to see existing ones.',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/offers', clean(input));
      },
    },

    {
      name: 'get_offer',
      description:
        'Get full detail for one offer by id — services included, discount %, offer price, validity dates, is_active, branches. Use before update_offer to read existing values.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        return api.get(`/offers/${id}`);
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — reports + wallet
    // ════════════════════════════════════════════════════════════════

    {
      name: 'get_reports',
      description:
        'Pull aggregated KPIs for a given period. Backend supports SIX report types and SEVEN periods:\n\n• **type=home** (default) — revenue, bookings_count, AOV — the home dashboard payload.\n• **type=services** — per-service breakdown (count, revenue, top sellers).\n• **type=offers** — per-offer breakdown.\n• **type=customers** — top customers by visit count / spend.\n• **type=employees** — per-employee breakdown (bookings + revenue).\n• **type=employees_commissions** — payroll-style per-employee commission summary.\n\nPeriods: `day` (today), `week`, `month`, `3months`, `6months`, `9months`, `year`.\n\nOptional branch_id / employee_id to narrow. Use for "كم دخلي اليوم / how much did I make this week / show me my top employees this quarter".',
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
      handler: async (input) => {
        return api.get('/reports', clean({ type: 'home', ...input }));
      },
    },

    {
      name: 'get_wallet',
      description:
        'Get the vendor wallet balance + recent transactions. Optional branch_id. Use for "كم في محفظتي / what\'s my balance".',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        per_page: z.number().int().min(1).max(50).optional(),
      }),
      handler: async (input) => {
        return api.get('/wallet', clean(input));
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — invoices (Phase B — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'list_invoices',
      description:
        'List ZATCA-issued tax invoices. Each invoice carries an invoice_number, booking_id, total, vat, date. Use for "اعرض فواتيري / show my invoices this month" or before download_invoice. Optional filters: branch_id, per_page, page.\n\n**Only meaningful for ZATCA-active vendors** — non-ZATCA vendors don\'t generate invoices, so the list will be empty.',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        page: z.number().int().min(1).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/invoices', clean(input));
      },
    },

    {
      name: 'get_invoice',
      description:
        'Get full detail for one tax invoice — invoice_number, booking details, line items with per-service price + VAT, customer info, ZATCA submission status + uuid.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        return api.get(`/invoices/${id}`);
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — reviews (Phase B — NEW, May-2026 reviews refactor)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'list_reviews',
      description:
        'List customer reviews on this vendor\'s bookings. May-2026 refactor: `employee_rate` (1-5) is the canonical rating column — `service_rate` was deprecated and dropped. Returns paginated reviews PLUS a `summary` block with `{ average, count, breakdown: {1..5: n} }` computed across the current filter set.\n\nFilters: branch_id, employee_id, rating (1-5), from/to (YYYY-MM-DD on start_time), page, per_page.\n\nUse for "كم تقييم عندي / اعرض أحدث ٥ تقييمات / كم نجوم متوسطي / من اللي قيمني نجمة".\n\n**Don\'t expose review ids in your reply** — refer to the rating + customer name + comment text instead.',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
        rating: z
          .union([z.number().int().min(1).max(5), z.string()])
          .optional()
          .describe('Filter to a specific 1-5 employee_rate.'),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Lower bound on booking start_time (YYYY-MM-DD).'),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Upper bound on booking start_time (YYYY-MM-DD).'),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/reviews', clean(input));
      },
    },

    {
      name: 'get_review',
      description:
        'Get full detail for one review by id — customer info, booking context (branch, employee, start_time, status), employee_rate (1-5), employee_comment, created_at.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        return api.get(`/reviews/${id}`);
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — cancellation reasons (Phase B — NEW, May-2026)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'list_cancellation_reasons',
      description:
        'List the vendor\'s curated cancellation reasons (the picker shown to customers when they cancel a booking). Each reason has id, reason_ar, reason_en (optional), sort order, is_active. First visit auto-seeds a default set (Emergency, Schedule change, Health issue, Found a better option, Vendor running late).\n\nUse before cancel_booking when the vendor wants to pick a structured reason (cancel_reason_id) instead of typing a free-text one, OR before create_cancellation_reason to see the existing list.',
      inputSchema: z.object({
        q: z.string().optional().describe('Free-text search on reason_ar / reason_en.'),
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
        skip_seed: z
          .boolean()
          .optional()
          .describe(
            'Set true to skip auto-seeding the default reasons on first visit. Default false.',
          ),
      }),
      handler: async (input) => {
        return api.getRaw(
          '/cancellation-reasons',
          clean({ ...input, skip_seed: input.skip_seed ? '1' : undefined }),
        );
      },
    },

    {
      name: 'get_cancellation_reason',
      description: 'Get one cancellation reason by id (reason_ar, reason_en, sort, is_active).',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        return api.get(`/cancellation-reasons/${id}`);
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — settings (Phase B — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'get_settings',
      description:
        'Get the vendor\'s storefront settings: `booking_differance` (lead time in minutes before customers can book), `calender_differance` (calendar resolution in minutes), `cancel_booking` (0=customers cannot self-cancel, 1=they can), `reviews_enabled` (0=disable customer-facing review CTA + vendor dashboard, 1=on), `terms` (terms-and-conditions blurb shown at booking). Use before update_settings.',
      inputSchema: z.object({}),
      handler: async () => {
        return api.get('/settings');
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — promo codes (Phase B — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'list_promo_codes',
      description:
        'List vendor-owned promo codes. Each has id, code (alphanumeric, 5+ chars), discount_type (`percentage` / `fixed`), value, start_date, end_date, uses (cap), used (current redemption count), is_active. Use before create_promo_code to see existing ones.',
      inputSchema: z.object({
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/promo-codes', clean(input));
      },
    },

    {
      name: 'get_promo_code',
      description: 'Get full detail for one promo code by id.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        return api.get(`/promo-codes/${id}`);
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — ZATCA (Phase C — view side)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'get_zatca',
      description:
        'Get the vendor\'s ZATCA (Saudi tax authority) registration status. Returns `{ registered, active, seller_name_ar, seller_name_en, tax_number, address, environment, ... }`. A vendor is "ZATCA-active" (issues real tax invoices) only when BOTH `registered === 1` AND `active === 1`. Use before any tax-related conversation.',
      inputSchema: z.object({}),
      handler: async () => {
        return api.get('/zatca');
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — roles + permissions (Phase C — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'list_roles',
      description:
        'List vendor-scoped roles (used when creating an employee — role_id must be one of these). Each has id, name, permissions list, is_active. Vendor-managed; do NOT confuse with the global Spatie permission roles.',
      inputSchema: z.object({
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/roles', clean(input));
      },
    },

    {
      name: 'get_role',
      description: 'Get full detail for one role — its permissions list and is_active flag.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        return api.get(`/roles/${id}`);
      },
    },

    {
      name: 'list_permissions',
      description:
        'List every permission node the vendor can assign to a role (e.g. `bookings.list`, `services.edit`, `wallets.list`). Use before create_role / update_role so you can construct the `permissions[]` array correctly.',
      inputSchema: z.object({}),
      handler: async () => {
        return api.getRaw('/permissions');
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  READ — reminders (Phase D — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'list_reminders',
      description:
        'List the vendor\'s booking-reminder configurations (when to remind customers before their booking — e.g. 24h before, 1h before). Each has id, name, minutes_before, is_active, channel ids (which channels deliver this reminder).',
      inputSchema: z.object({
        page: z.number().int().min(1).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/reminders', clean(input));
      },
    },

    {
      name: 'get_reminder',
      description: 'Get full detail for one reminder configuration by id.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        return api.get(`/reminders/${id}`);
      },
    },

    {
      name: 'get_reminder_channels',
      description:
        'Get the vendor\'s reminder delivery channels (SMS / Email / Push / WhatsApp). Returns the channel rows with enabled flags. Use before update_reminder_channels.',
      inputSchema: z.object({}),
      handler: async () => {
        return api.get('/reminder-channels');
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — bookings (existing, hardened for offers + cancel reason)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'create_booking',
      description:
        'Create a new booking.\n\nRequired: branch_id, employee_id, AT LEAST ONE OF { `service_ids` (array) OR `offer_ids` (array) }, AND ONE OF { `local_datetime` (preferred) OR `booking_timestamp` (advanced) }.\n\n**`service_ids` vs `offer_ids`** — booking a regular service uses `service_ids: [10, 22]`. Booking an offer/promotion uses `offer_ids: [5]` and the backend resolves the underlying services + discount automatically. You can pass BOTH in the same booking if the vendor is bundling a promo with an ad-hoc service.\n\n**TIMEZONE — READ THIS:** The vendor is in Saudi Arabia (Asia/Riyadh, UTC+3). Use the `local_datetime` field with Saudi-local time as `{ date: "YYYY-MM-DD", time: "HH:MM" }` and the server converts to the correct unix instant for you. DO NOT compute unix timestamps in your head — it goes wrong (a previous booking ended up six days early because of this). If you need to know today\'s date in Saudi, call `get_current_time` first.\n\n**`customer_id` is OPTIONAL** — if the user doesn\'t mention a specific customer, OMIT this field entirely. The backend treats `customer_id: null` as a "walk-in / auto-customer" booking which is a perfectly valid state (the mobile POS uses this every time a vendor rings up a walk-in). Do NOT ask the user "which customer?" when they didn\'t mention one — go ahead and create the booking without it. The booking will display as "عميل تلقائي" (auto-customer) in the UI.\n\nWhen `customer_id` IS provided, it must be the User table id (not the Customer table id). Use list_customers and read the `id` field from a result, OR create_customer first and use the returned id.\n\nOther optional fields: notes, payment_way (`cash`/`online`, default cash), status (default `confirmed`), payment_status (0 unpaid / 1 paid; default 0). Use list_branches → list_employees → list_services first to gather the required ids. CONFIRM the full booking before creating.',
      inputSchema: z
        .object({
          branch_id: idLike,
          employee_id: idLike,
          customer_id: idLike
            .optional()
            .describe(
              'OPTIONAL — omit for walk-in / auto-customer bookings. User table id (not Customer table id) when provided.',
            ),
          service_ids: z
            .array(idLike)
            .min(1)
            .optional()
            .describe(
              'Required if `offer_ids` is not provided. Array of service ids.',
            ),
          offer_ids: z
            .array(idLike)
            .min(1)
            .optional()
            .describe(
              'Required if `service_ids` is not provided. Array of offer ids — backend resolves services + discount automatically.',
            ),
          local_datetime: z
            .object({
              date: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .describe('YYYY-MM-DD (Saudi local). e.g. "2026-05-23".'),
              time: z
                .string()
                .regex(hourPattern)
                .describe('HH:MM 24h (Saudi local). e.g. "21:00" for 9 PM.'),
            })
            .optional()
            .describe(
              'PREFERRED. Saudi-local datetime. Server converts to unix using Asia/Riyadh (UTC+3).',
            ),
          booking_timestamp: z
            .number()
            .int()
            .optional()
            .describe(
              'ADVANCED — only use if you already have a verified unix timestamp. Otherwise use local_datetime.',
            ),
          notes: z.string().optional(),
          payment_way: z.enum(['cash', 'online']).optional(),
          status: z
            .enum(['confirmed', 'completed'])
            .optional()
            .describe(
              'Walk-in completed sales should use "completed" + payment_status=1. Future bookings use "confirmed".',
            ),
          payment_status: z.union([z.literal(0), z.literal(1)]).optional(),
        })
        .refine(
          (v) =>
            (v.service_ids && v.service_ids.length > 0) ||
            (v.offer_ids && v.offer_ids.length > 0),
          {
            message:
              'Either `service_ids` or `offer_ids` is required to create a booking.',
          },
        ),
      handler: async (input) => {
        // Resolve the timestamp: prefer local_datetime (server-side
        // conversion, immune to model timezone math), fall back to
        // explicit booking_timestamp if the caller really has one.
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
            'Either `local_datetime` (preferred, Saudi-local) or `booking_timestamp` (unix seconds) is required.',
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

        if (input.service_ids && input.service_ids.length > 0) {
          payload.service_ids = input.service_ids;
        }
        if (input.offer_ids && input.offer_ids.length > 0) {
          payload.offer_ids = input.offer_ids;
        }

        // Only attach customer_id if explicitly provided. Sending it
        // as null/undefined in multipart would serialize to the
        // literal string "null" which fails `exists:users,id`.
        if (input.customer_id !== undefined && input.customer_id !== null) {
          payload.customer_id = input.customer_id;
        }
        return api.post('/bookings', payload, { multipart: true });
      },
    },

    {
      name: 'cancel_booking',
      description:
        'Cancel a booking by id. Sets status to `canceled`. REFUSES if the booking is already `completed` (the invoice is issued and reports are balanced — completed bookings are final at this layer). CONFIRM with the user before calling — display the booking detail first via get_booking and ask "هل أكدت الإلغاء؟" or equivalent. Returns the updated booking.\n\n**May-2026 cancellation reasons:**\n• `cancellation_reason` (string, 2-500 chars) — free-text reason. Use this when the vendor types a custom reason or picks "Other".\n• `cancel_reason_id` — id from `list_cancellation_reasons` when the vendor picks a structured reason from the curated list.\nPass one or both. They\'re both optional but recording at least the free-text reason gives you better historical analytics.',
      inputSchema: z.object({
        id: idLike,
        cancellation_reason: z
          .string()
          .min(2)
          .max(500)
          .optional()
          .describe('Free-text reason for the cancel (2-500 chars).'),
        cancel_reason_id: idLike
          .optional()
          .describe(
            'Structured reason id from list_cancellation_reasons. Optional.',
          ),
      }),
      handler: async ({ id, cancellation_reason, cancel_reason_id }) => {
        const detail = await api.get(`/bookings/${id}`);
        ensureNotCompleted(detail, 'cancel');
        const { service_ids, offer_ids } = existingServiceAndOfferIds(detail);
        // The backend's PUT /bookings/{id} requires the full payload
        // (no patch-status route exists). We round-trip the existing
        // values and only override `status`. customer_id is OPTIONAL
        // on the backend — if the original booking had no customer
        // (walk-in / auto), we must NOT invent one. `clean()` drops
        // null/undefined so the field disappears from FormData.
        const payload: Record<string, any> = {
          branch_id: detail.branch?.id ?? detail.branch_id,
          employee_id: detail.employee?.id ?? detail.employee_id,
          customer_id: existingCustomerId(detail),
          payment_way: detail.payment_way || 'cash',
          payment_status: detail.payment_status ?? 0,
          start_time: detail.start_time,
          booking_timestamp:
            detail.booking_timestamp ||
            Math.floor(
              new Date(String(detail.start_time).replace(' ', 'T')).getTime() /
                1000,
            ),
          notes: detail.notes || '',
          status: 'canceled',
        };
        if (service_ids.length > 0) payload.service_ids = service_ids;
        if (offer_ids.length > 0) payload.offer_ids = offer_ids;
        if (cancellation_reason) payload.cancellation_reason = cancellation_reason;
        if (cancel_reason_id) payload.cancel_reason_id = cancel_reason_id;
        return api.putViaPost(`/bookings/${id}`, clean(payload), {
          multipart: true,
        });
      },
    },

    {
      name: 'complete_booking',
      description:
        'Mark a booking as completed (customer showed + service delivered). Sets status `completed` AND payment_status=1 automatically — that mirrors the mobile app\'s "إتمام البيع" flow. REFUSES if the booking is already completed (no-op). CONFIRM before calling. Returns the updated booking.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        const detail = await api.get(`/bookings/${id}`);
        ensureNotCompleted(detail, 're-complete');
        const { service_ids, offer_ids } = existingServiceAndOfferIds(detail);
        const payload: Record<string, any> = {
          branch_id: detail.branch?.id ?? detail.branch_id,
          employee_id: detail.employee?.id ?? detail.employee_id,
          customer_id: existingCustomerId(detail),
          payment_way: detail.payment_way || 'cash',
          payment_status: 1,
          start_time: detail.start_time,
          booking_timestamp:
            detail.booking_timestamp ||
            Math.floor(
              new Date(String(detail.start_time).replace(' ', 'T')).getTime() /
                1000,
            ),
          notes: detail.notes || '',
          status: 'completed',
        };
        if (service_ids.length > 0) payload.service_ids = service_ids;
        if (offer_ids.length > 0) payload.offer_ids = offer_ids;
        return api.putViaPost(`/bookings/${id}`, clean(payload), {
          multipart: true,
        });
      },
    },

    {
      name: 'mark_no_show',
      description:
        'Mark a booking as `missed` (customer didn\'t show up). Same shape as cancel_booking but the status semantics are different — `missed` does not refund the slot in reports. REFUSES if the booking is already completed. CONFIRM before calling.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => {
        const detail = await api.get(`/bookings/${id}`);
        ensureNotCompleted(detail, 'mark as no-show');
        const { service_ids, offer_ids } = existingServiceAndOfferIds(detail);
        const payload: Record<string, any> = {
          branch_id: detail.branch?.id ?? detail.branch_id,
          employee_id: detail.employee?.id ?? detail.employee_id,
          customer_id: existingCustomerId(detail),
          payment_way: detail.payment_way || 'cash',
          payment_status: detail.payment_status ?? 0,
          start_time: detail.start_time,
          booking_timestamp:
            detail.booking_timestamp ||
            Math.floor(
              new Date(String(detail.start_time).replace(' ', 'T')).getTime() /
                1000,
            ),
          notes: detail.notes || '',
          status: 'missed',
        };
        if (service_ids.length > 0) payload.service_ids = service_ids;
        if (offer_ids.length > 0) payload.offer_ids = offer_ids;
        return api.putViaPost(`/bookings/${id}`, clean(payload), {
          multipart: true,
        });
      },
    },

    {
      name: 'reschedule_booking',
      description:
        'Move an existing booking to a new start time (and optionally a different employee). Backend recomputes end_time from the service durations. REFUSES if the booking is already completed (you can\'t move a transaction that already happened).\n\n**TIMEZONE — READ THIS:** Pass the new time as `local_datetime` ({ date: "YYYY-MM-DD", time: "HH:MM" } in Saudi local — Asia/Riyadh UTC+3). The server converts to unix for you. DO NOT compute unix timestamps in your head; previous attempts landed bookings several days off. If you need today\'s Saudi date, call `get_current_time` first.\n\nCONFIRM before calling — repeat back the booking, the old time, and the new time to the user before invoking.',
      inputSchema: z.object({
        id: idLike,
        local_datetime: z
          .object({
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .describe('YYYY-MM-DD (Saudi local).'),
            time: z
              .string()
              .regex(hourPattern)
              .describe('HH:MM 24h (Saudi local). e.g. "21:00" for 9 PM.'),
          })
          .optional()
          .describe('PREFERRED. Saudi-local datetime — server converts.'),
        booking_timestamp: z
          .number()
          .int()
          .optional()
          .describe('ADVANCED — only if you already have a verified unix.'),
        employee_id: idLike
          .optional()
          .describe(
            'Override the employee if reassigning at the same time. The backend requires it on the reschedule endpoint; if omitted we re-use the booking\'s existing employee.',
          ),
      }),
      handler: async ({
        id,
        local_datetime,
        booking_timestamp,
        employee_id,
      }) => {
        // Pre-flight: refuse on completed. We have to GET the detail
        // for this check — the dedicated /reschedule endpoint doesn't
        // bounce the call itself.
        const detail = await api.get(`/bookings/${id}`);
        ensureNotCompleted(detail, 'reschedule');

        let timestamp: number | undefined;
        if (local_datetime) {
          timestamp = saudiLocalToUnix(local_datetime.date, local_datetime.time);
        } else if (booking_timestamp !== undefined) {
          timestamp = booking_timestamp;
        } else {
          throw new Error(
            'Either `local_datetime` (preferred, Saudi-local) or `booking_timestamp` (unix seconds) is required for reschedule_booking.',
          );
        }

        // RescheduleBookingRequest validates `employee_id` as
        // required|exists:employees,id. If the caller didn't supply
        // one, re-use the booking's current employee.
        const resolvedEmployeeId =
          employee_id ?? detail.employee?.id ?? detail.employee_id;

        return api.post(
          `/bookings/${id}/reschedule`,
          clean({ booking_timestamp: timestamp, employee_id: resolvedEmployeeId }),
          { multipart: true },
        );
      },
    },

    {
      name: 'update_booking_notes',
      description:
        'Append or replace the notes on a booking without touching anything else. Pass `mode: "append"` to add to existing notes (separator: newline) or `mode: "replace"` (default) to overwrite. Notes-only edits are ALLOWED on completed bookings (they\'re metadata, not status) — useful for adding a post-service comment like "customer asked for shorter sides next time".',
      inputSchema: z.object({
        id: idLike,
        notes: z.string(),
        mode: z.enum(['append', 'replace']).optional(),
      }),
      handler: async ({ id, notes, mode }) => {
        const detail = await api.get(`/bookings/${id}`);
        const { service_ids, offer_ids } = existingServiceAndOfferIds(detail);
        // Notes are NOT gated by completed — see tool description.
        const nextNotes =
          mode === 'append' && detail.notes ? `${detail.notes}\n${notes}` : notes;
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
              new Date(String(detail.start_time).replace(' ', 'T')).getTime() /
                1000,
            ),
          notes: nextNotes,
        };
        if (service_ids.length > 0) payload.service_ids = service_ids;
        if (offer_ids.length > 0) payload.offer_ids = offer_ids;
        return api.putViaPost(`/bookings/${id}`, clean(payload), {
          multipart: true,
        });
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — POS preview (Phase B — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'preview_booking',
      description:
        'Preview the price + duration + employee math for a potential booking WITHOUT creating it. Mirrors the in-app POS calculator — pass `branch_id` + `service_ids` (and/or `offer_ids`) + optional `employee_id`, and the backend returns the computed total, VAT (if ZATCA), per-service breakdown, and the available employees for those services. Use when the user asks "كم حصل لو حجز سمير حلاقة + لحية" before actually booking — gives them the number so they can decide.',
      inputSchema: z.object({
        branch_id: idLike.optional(),
        employee_id: idLike.optional(),
        service_ids: z.array(idLike).min(1).optional(),
        offer_ids: z.array(idLike).min(1).optional(),
      }),
      handler: async (input) => {
        return api.post('/pos', clean(input), { multipart: true });
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — sections
    // ════════════════════════════════════════════════════════════════

    {
      name: 'create_section',
      description:
        'Create a new service section. The backend ONLY accepts `name_ar` (required, ≥2 chars) and `description_ar` (optional). Do NOT send branch_id / name_en — the FormRequest does not include them and adding them confuses the request. CONFIRM the name with the user before calling.',
      inputSchema: z.object({
        name_ar: z
          .string()
          .min(2)
          .describe('Arabic name. Min 2 chars. Example: "قسم الحلاقة".'),
        description_ar: z.string().optional(),
      }),
      handler: async (input) => {
        return api.post('/sections', clean(input), { multipart: true });
      },
    },

    {
      name: 'update_section',
      description:
        'Update an existing section\'s name_ar / description_ar / sort order. Reads the current section first so you can omit any field you don\'t want to change. CONFIRM before calling.',
      inputSchema: z.object({
        id: idLike,
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().min(2).optional(),
        sort: z.number().int().min(1).optional(),
      }),
      handler: async (input) => {
        const current = await api.get(`/sections/${input.id}`);
        const payload: Record<string, any> = {
          name_ar: input.name_ar ?? current.name_ar ?? current.name ?? '',
        };
        if (input.description_ar !== undefined) {
          payload.description_ar = input.description_ar;
        } else if (current.description_ar) {
          payload.description_ar = current.description_ar;
        }
        if (input.sort !== undefined) payload.sort = input.sort;
        else if (typeof current.sort === 'number') payload.sort = current.sort;
        return api.putViaPost(`/sections/${input.id}`, payload, {
          multipart: true,
        });
      },
    },

    {
      name: 'activate_section',
      description:
        'Show a section on the customer-facing services page. The section\'s services don\'t auto-activate — they keep their own is_active state. CONFIRM before calling.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/sections/${id}/activate`),
    },

    {
      name: 'deactivate_section',
      description:
        'Hide a section from the customer-facing services page. Existing services in the section keep their own activation state; the section header just stops appearing. CONFIRM before calling.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/sections/${id}/deactivate`),
    },

    {
      name: 'sort_sections',
      description:
        'Bulk reorder sections by passing an array of `{ id, sort }` pairs. Lower sort = top. CONFIRM the full reorder with the user before calling.',
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              id: idLike,
              sort: z.number().int().min(0),
            }),
          )
          .min(1),
      }),
      handler: async ({ items }) => {
        return api.post('/sections/sort', { items }, { multipart: true });
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — services
    // ════════════════════════════════════════════════════════════════

    {
      name: 'create_service',
      description:
        'Create a new service. Required: name_ar (≥2), description_ar (≥2), price, service_time (minutes), section_id, branch_id (one or more — array). Optional: extra_time (minutes), featured (boolean), home-service fields.\n\n**Arabic-only.** The backend\'s name_en / description_en columns are nullable and not used by this MCP — never send English placeholders. The customer storefront falls back to the Arabic value automatically.\n\n**Home service (May-2026):** set `is_home_service: true` AND `home_hours: [{ day, start_time, end_time }, ...]` to mark the service as available at the customer\'s home. Optionally set `home_service_fee` (the surcharge on top of base price).\n\nCONFIRM the full payload before calling.',
      inputSchema: z.object({
        name_ar: z.string().min(2),
        description_ar: z.string().min(2),
        price: z.number().nonnegative(),
        service_time: z
          .number()
          .int()
          .positive()
          .describe('Duration in minutes.'),
        section_id: idLike,
        branch_id: z
          .array(idLike)
          .min(1)
          .describe(
            'One or more branch ids. MUST be an array — the backend rejects a single scalar.',
          ),
        extra_time: z.number().int().nonnegative().optional(),
        featured: z.boolean().optional(),
        is_home_service: z.boolean().optional(),
        home_service_fee: z
          .number()
          .nonnegative()
          .optional()
          .describe(
            'Surcharge added on top of the base price for home-service bookings.',
          ),
        home_hours: z
          .array(homeHourSchema)
          .optional()
          .describe(
            'Required when is_home_service=true. Per-weekday windows when the service can be booked at the customer\'s home.',
          ),
      }),
      handler: async (input) => {
        const payload: Record<string, any> = {
          name_ar: input.name_ar,
          description_ar: input.description_ar,
          price: input.price,
          service_time: input.service_time,
          section_id: input.section_id,
          branch_id: input.branch_id,
        };
        if (input.extra_time !== undefined) payload.extra_time = input.extra_time;
        if (input.featured !== undefined) payload.featured = bool01(input.featured);
        if (input.is_home_service !== undefined) {
          payload.is_home_service = bool01(input.is_home_service);
        }
        if (input.home_service_fee !== undefined) {
          payload.home_service_fee = input.home_service_fee;
        }
        if (input.home_hours && input.home_hours.length > 0) {
          payload.home_hours = input.home_hours;
        }
        return api.post('/services', payload, { multipart: true });
      },
    },

    {
      name: 'update_service',
      description:
        'Full service update — name, description, price, duration, section, branches, featured flag, home-service settings. Use this when the user wants to change MORE than just the price (for that, use update_service_price). Reads the current service first so you can omit any field you don\'t want to change. CONFIRM the full diff before calling.\n\n**Arabic-only.** name_en / description_en are nullable in the backend and not used by this MCP — they\'re never sent.\n\nHome-service toggles: setting `is_home_service=false` will WIPE existing home_hours rows server-side (the backend\'s syncHomeHours uses delete-all-then-insert). Setting it to true requires `home_hours` to be passed alongside.',
      inputSchema: z.object({
        id: idLike,
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().min(2).optional(),
        price: z.number().nonnegative().optional(),
        service_time: z.number().int().positive().optional(),
        extra_time: z.number().int().nonnegative().optional(),
        section_id: idLike.optional(),
        branch_id: z.array(idLike).optional(),
        featured: z.boolean().optional(),
        is_home_service: z.boolean().optional(),
        home_service_fee: z.number().nonnegative().optional(),
        home_hours: z.array(homeHourSchema).optional(),
      }),
      handler: async (input) => {
        const current = await api.get(`/services/${input.id}`);
        const currentBranchIds: any[] = Array.isArray(current.branches)
          ? current.branches.map((b: any) => b.id ?? b)
          : current.branch_id
            ? [current.branch_id]
            : [];
        const payload: Record<string, any> = {
          name_ar: input.name_ar ?? current.name_ar ?? current.name ?? '',
          description_ar:
            input.description_ar ??
            current.description_ar ??
            current.description ??
            '-',
          price: input.price ?? current.price,
          service_time: input.service_time ?? current.service_time ?? 30,
          section_id: input.section_id ?? current.section?.id ?? current.section_id,
          branch_id: input.branch_id ?? currentBranchIds,
        };
        // `extra_time` must never be sent as the literal string "null".
        // Send a numeric value or omit entirely.
        if (input.extra_time !== undefined) {
          payload.extra_time = input.extra_time;
        } else if (typeof current.extra_time === 'number') {
          payload.extra_time = current.extra_time;
        }
        const featuredVal = input.featured ?? current.featured;
        if (featuredVal !== undefined && featuredVal !== null) {
          payload.featured =
            typeof featuredVal === 'boolean'
              ? bool01(featuredVal)
              : Number(featuredVal)
                ? '1'
                : '0';
        }
        // Home-service fields. The is_home_service flag carries
        // through; home_hours must be re-sent when the toggle stays
        // ON (the backend wipes + reinserts on every update).
        const homeOn =
          input.is_home_service !== undefined
            ? input.is_home_service
            : Number(current.is_home_service) === 1;
        if (homeOn) {
          payload.is_home_service = '1';
          if (input.home_service_fee !== undefined) {
            payload.home_service_fee = input.home_service_fee;
          } else if (current.home_service_fee !== undefined) {
            payload.home_service_fee = current.home_service_fee;
          }
          // Prefer caller-supplied home_hours; fall back to current.
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
      },
    },

    {
      name: 'update_service_price',
      description:
        'Update ONLY the price (and optionally service_time / featured) of a service. Heavier edits (name, description, branches, section, home service) belong to `update_service` — this one is scoped tight on purpose so vendors can say "ارفع سعر الحلاقة لـ 45 ريال" and the change is unambiguous. CONFIRM before calling. Reads the service first so the rest of the payload (name_ar, description_ar, section_id, branch_id) is preserved.',
      inputSchema: z.object({
        id: idLike,
        price: z.number().nonnegative(),
        service_time: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Service duration in minutes (optional).'),
        featured: z.boolean().optional().describe('Optional featured flag.'),
      }),
      handler: async ({ id, price, service_time, featured }) => {
        const current = await api.get(`/services/${id}`);
        const branchIds: any[] = Array.isArray(current.branches)
          ? current.branches.map((b: any) => b.id ?? b)
          : current.branch_id
            ? [current.branch_id]
            : [];
        const payload: Record<string, any> = {
          name_ar: current.name_ar || current.name || '',
          description_ar: current.description_ar || current.description || '-',
          section_id: current.section?.id ?? current.section_id,
          price,
          service_time: service_time ?? current.service_time ?? 30,
          featured:
            featured === undefined
              ? current.featured
                ? '1'
                : '0'
              : bool01(featured),
          // branch_id MUST be an array (FormRequest expects branch_id[]).
          branch_id: branchIds,
        };
        return api.putViaPost(`/services/${id}`, payload, { multipart: true });
      },
    },

    {
      name: 'activate_service',
      description:
        'Make a service visible to customers (`is_active = 1`). Separate POST endpoint from updates — not a payload field. CONFIRM before calling.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/services/${id}/activate`),
    },

    {
      name: 'deactivate_service',
      description:
        'Hide a service from customers (`is_active = 0`). The service stays in the catalog and historical bookings keep working — only NEW customer-side selection is blocked. CONFIRM before calling.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/services/${id}/deactivate`),
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — offers (Phase A — FIXED + Phase C — update/activate)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'create_offer',
      description:
        'Create a promotional offer. Backend requirements (May-2026):\n• `name_ar` ≥ 2 chars (required)\n• `description_ar` ≥ 2 chars (required)\n• `section_id` (required — pick from list_sections)\n• `service_ids` array of one or more service ids (required)\n• `branch_id` array of one or more branch ids (required)\n• `price_type` — one of "service" / "free" / "discount" / "special"\n• `service_price` (required) — the anchor price the discount math is computed against (usually the first service\'s current price)\n• `discount_percentage` and `offer_price` — required by the backend; the MCP computes them from `price_type` + `service_price` if not supplied:\n  – "service" → offer_price = service_price, discount = 0\n  – "free" → offer_price = 0, discount = 100\n  – "discount" → caller provides discount_percentage; offer_price auto-computed\n  – "special" → caller provides offer_price; discount_percentage auto-computed\n\n**Arabic-only.** name_en / description_en are nullable and not sent.\n\nCONFIRM the pricing math with the user before calling.',
      inputSchema: z.object({
        name_ar: z.string().min(2),
        description_ar: z.string().min(2),
        section_id: idLike,
        service_ids: z.array(idLike).min(1),
        branch_id: z.array(idLike).min(1),
        price_type: z.enum(['service', 'free', 'discount', 'special']),
        service_price: z
          .number()
          .nonnegative()
          .describe(
            'Anchor price the discount math is computed against. Usually the underlying service\'s current price.',
          ),
        discount_percentage: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Required for price_type="discount". 0-100.'),
        offer_price: z
          .number()
          .nonnegative()
          .optional()
          .describe('Required for price_type="special". The promo price.'),
        sort: z.number().int().min(1).optional(),
      }),
      handler: async (input) => {
        // Compute the price/discount pair the backend expects based on
        // the price_type. Backend OfferRequest requires BOTH
        // `discount_percentage` AND `offer_price` on every create.
        let discount_percentage = input.discount_percentage ?? 0;
        let offer_price = input.offer_price ?? 0;
        switch (input.price_type) {
          case 'service':
            offer_price = input.service_price;
            discount_percentage = 0;
            break;
          case 'free':
            offer_price = 0;
            discount_percentage = 100;
            break;
          case 'discount':
            offer_price = input.service_price * ((100 - discount_percentage) / 100);
            break;
          case 'special':
            if (input.service_price > 0 && offer_price >= 0) {
              discount_percentage =
                ((input.service_price - offer_price) / input.service_price) * 100;
            }
            break;
        }
        const payload: Record<string, any> = {
          name_ar: input.name_ar,
          description_ar: input.description_ar,
          section_id: input.section_id,
          service_id: input.service_ids, // Backend wants `service_id` (singular field name) holding an array.
          branch_id: input.branch_id,
          price_type: input.price_type,
          service_price: input.service_price,
          discount_percentage,
          offer_price,
        };
        if (input.sort !== undefined) payload.sort = input.sort;
        return api.post('/offers', clean(payload), { multipart: true });
      },
    },

    {
      name: 'update_offer',
      description:
        'Update an existing offer. Same fields as create_offer but every field is OPTIONAL — reads the current offer first and merges your edits. CONFIRM the diff before calling.',
      inputSchema: z.object({
        id: idLike,
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().min(2).optional(),
        section_id: idLike.optional(),
        service_ids: z.array(idLike).min(1).optional(),
        branch_id: z.array(idLike).min(1).optional(),
        price_type: z.enum(['service', 'free', 'discount', 'special']).optional(),
        service_price: z.number().nonnegative().optional(),
        discount_percentage: z.number().min(0).max(100).optional(),
        offer_price: z.number().nonnegative().optional(),
        sort: z.number().int().min(1).optional(),
      }),
      handler: async (input) => {
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
          input.price_type ?? current.price_type ?? 'service';
        const servicePrice =
          input.service_price ??
          Number(current.service_price ?? current.price ?? 0);
        let discount_percentage =
          input.discount_percentage ?? Number(current.discount_percentage ?? 0);
        let offer_price =
          input.offer_price ?? Number(current.offer_price ?? 0);
        switch (priceType) {
          case 'service':
            offer_price = servicePrice;
            discount_percentage = 0;
            break;
          case 'free':
            offer_price = 0;
            discount_percentage = 100;
            break;
          case 'discount':
            if (input.discount_percentage !== undefined) {
              offer_price = servicePrice * ((100 - discount_percentage) / 100);
            }
            break;
          case 'special':
            if (servicePrice > 0 && input.offer_price !== undefined) {
              discount_percentage =
                ((servicePrice - offer_price) / servicePrice) * 100;
            }
            break;
        }
        const payload: Record<string, any> = {
          name_ar: input.name_ar ?? current.name_ar ?? current.name ?? '',
          description_ar:
            input.description_ar ??
            current.description_ar ??
            current.description ??
            '-',
          section_id: input.section_id ?? current.section?.id ?? current.section_id,
          service_id:
            input.service_ids && input.service_ids.length > 0
              ? input.service_ids
              : currentServiceIds,
          branch_id:
            input.branch_id && input.branch_id.length > 0
              ? input.branch_id
              : currentBranchIds,
          price_type: priceType,
          service_price: servicePrice,
          discount_percentage,
          offer_price,
        };
        if (input.sort !== undefined) payload.sort = input.sort;
        return api.putViaPost(`/offers/${input.id}`, payload, {
          multipart: true,
        });
      },
    },

    {
      name: 'activate_offer',
      description: 'Re-enable an offer (`is_active = 1`). CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/offers/${id}/activate`),
    },

    {
      name: 'deactivate_offer',
      description:
        'Hide an offer from customers (`is_active = 0`). Historical bookings that used it keep their pricing; only NEW customer selection is blocked. CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/offers/${id}/deactivate`),
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — customers
    // ════════════════════════════════════════════════════════════════

    {
      name: 'create_customer',
      description:
        'Create a new customer record. Backend auto-links to an existing User row if phone/email already exists in the platform. Required: first_name, phone. Optional: last_name, email. Phone should be digits-only (strip + and country code). NOTE: this endpoint takes JSON, not multipart — diverging from the rest of the API. CONFIRM the contact info before calling.',
      inputSchema: z.object({
        first_name: z.string().min(1),
        last_name: z.string().optional(),
        phone: z
          .string()
          .describe('Digits only (e.g. "0501234567"). Strip + and country code first.'),
        email: z.string().email().optional(),
      }),
      handler: async (input) => {
        // /customers POST is JSON not multipart — this is the one
        // endpoint that differs from the standard write pattern.
        return api.post('/customers', clean(input));
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — employees (Phase A — FIXED + Phase C — update)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'create_employee',
      description:
        'Add a new employee. Backend requirements (May-2026):\n• `first_name` (required) and `last_name` (optional)\n• `phone` (digits only) + `email` (must be unique among type=employee users)\n• `branch_id` (single branch, required)\n• `role_id` (required — must be one of the vendor\'s own roles; call list_roles to discover)\n• `official_hours` — REQUIRED array of `{ day, start_time, end_time }` for every working day. `day` is one of `sat sun mon tue wed thu fri`, times are `HH:MM` 24h.\n\nOptional:\n• `service_ids` — array of services this employee performs (backend stores as `service_id[]`)\n• `break_hours` — same shape as official_hours, for paid breaks within working hours\n• `bio` (May-2026) — single multilingual bio shown on the customer-facing employee profile (2-1000 chars)\n• `job_title`, `salary`, `start_date`, `end_date` (YYYY-MM-DD, end after start)\n• `commission_type` (`none` / `fixed` / `percentage`), `commission` numeric, `commission_calculation_method` (`gross` / `net`)\n\nThis creates a real user account with login credentials — CONFIRM every field with the vendor before calling. Default password "12345678" is used when the caller doesn\'t provide one (vendor can change it later through the employee\'s own login).',
      inputSchema: z.object({
        first_name: z.string().min(1),
        last_name: z.string().min(1).optional(),
        phone: z.string().min(7),
        email: z.string().email(),
        password: z.string().min(8).optional(),
        branch_id: idLike,
        role_id: idLike,
        service_ids: z.array(idLike).optional(),
        official_hours: z
          .array(officialHourSchema)
          .min(1)
          .describe(
            'REQUIRED. One row per working day with start_time and end_time. At least one entry.',
          ),
        break_hours: z
          .array(officialHourSchema)
          .optional()
          .describe('Optional. Same shape as official_hours.'),
        bio: z.string().min(2).max(1000).optional(),
        job_title: z.string().optional(),
        salary: z.number().nonnegative().optional(),
        commission_type: z.enum(['none', 'fixed', 'percentage']).optional(),
        commission: z.number().nonnegative().optional(),
        commission_calculation_method: z.enum(['gross', 'net']).optional(),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD.'),
        end_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD. Must be after start_date.'),
      }),
      handler: async (input) => {
        const payload: Record<string, any> = {
          first_name: input.first_name,
          phone: input.phone,
          email: input.email,
          branch_id: input.branch_id,
          role_id: input.role_id,
          official_hours: input.official_hours,
        };
        if (input.last_name) payload.last_name = input.last_name;
        if (input.password) payload.password = input.password;
        else payload.password = '12345678';
        // EmployeeRequest validates `service_id` (singular field name) as
        // an array of exists:services,id. Pass through under that key.
        if (input.service_ids && input.service_ids.length > 0) {
          payload.service_id = input.service_ids;
        }
        if (input.break_hours && input.break_hours.length > 0) {
          payload.break_hours = input.break_hours;
        }
        if (input.bio) payload.bio = input.bio;
        if (input.job_title) payload.job_title = input.job_title;
        if (input.salary !== undefined) payload.salary = input.salary;
        if (input.commission_type) payload.commission_type = input.commission_type;
        if (input.commission !== undefined) payload.commission = input.commission;
        if (input.commission_calculation_method) {
          payload.commission_calculation_method = input.commission_calculation_method;
        }
        if (input.start_date) payload.start_date = input.start_date;
        if (input.end_date) payload.end_date = input.end_date;
        return api.post('/employees', payload, { multipart: true });
      },
    },

    {
      name: 'update_employee',
      description:
        'Update an existing employee. Same fields as create_employee, but EVERY field is OPTIONAL — reads the current employee first and merges your edits. The backend\'s EmployeeRequest still enforces `official_hours` as required on PUT, so the MCP echoes the current value back when you don\'t supply new hours. CONFIRM the diff with the vendor before calling.',
      inputSchema: z.object({
        id: idLike,
        first_name: z.string().min(1).optional(),
        last_name: z.string().min(1).optional(),
        phone: z.string().min(7).optional(),
        email: z.string().email().optional(),
        branch_id: idLike.optional(),
        role_id: idLike.optional(),
        service_ids: z.array(idLike).optional(),
        official_hours: z.array(officialHourSchema).optional(),
        break_hours: z.array(officialHourSchema).optional(),
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
        if (input.last_name ?? currentUser.last_name) {
          payload.last_name = input.last_name ?? currentUser.last_name;
        }
        if (input.service_ids && input.service_ids.length > 0) {
          payload.service_id = input.service_ids;
        } else if (currentServiceIds.length > 0) {
          payload.service_id = currentServiceIds;
        }
        if (input.break_hours && input.break_hours.length > 0) {
          payload.break_hours = input.break_hours;
        } else if (currentBreakHours.length > 0) {
          payload.break_hours = currentBreakHours;
        }
        if (input.bio !== undefined) payload.bio = input.bio;
        else if (current.bio) payload.bio = current.bio;
        if (input.job_title ?? current.job_title) {
          payload.job_title = input.job_title ?? current.job_title;
        }
        if (input.salary !== undefined) payload.salary = input.salary;
        else if (current.salary !== undefined && current.salary !== null) {
          payload.salary = current.salary;
        }
        if (input.commission_type ?? current.commission_type) {
          payload.commission_type =
            input.commission_type ?? current.commission_type;
        }
        if (input.commission !== undefined) payload.commission = input.commission;
        else if (current.commission !== undefined && current.commission !== null) {
          payload.commission = current.commission;
        }
        if (input.commission_calculation_method ?? current.commission_calculation_method) {
          payload.commission_calculation_method =
            input.commission_calculation_method ?? current.commission_calculation_method;
        }
        if (input.start_date ?? current.start_date) {
          payload.start_date = input.start_date ?? current.start_date;
        }
        if (input.end_date ?? current.end_date) {
          payload.end_date = input.end_date ?? current.end_date;
        }
        return api.putViaPost(`/employees/${input.id}`, payload, {
          multipart: true,
        });
      },
    },

    {
      name: 'activate_employee',
      description:
        'Mark an employee active (can take bookings, appears in pickers). CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/employees/${id}/activate`),
    },

    {
      name: 'deactivate_employee',
      description:
        'Mark an employee inactive (hidden from booking pickers, kept in records). Use when an employee leaves or goes on extended leave. CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/employees/${id}/deactivate`),
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — employee portfolio (Phase C — NEW, May-2026)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'sort_employee_portfolio',
      description:
        'Bulk reorder an employee\'s portfolio gallery. Pass `items: [{ id, sort }, ...]` for every image with its new position (lower sort = top). CONFIRM the new order with the vendor before calling.',
      inputSchema: z.object({
        employee_id: idLike,
        items: z
          .array(
            z.object({
              id: idLike,
              sort: z.number().int().min(0),
            }),
          )
          .min(1),
      }),
      handler: async ({ employee_id, items }) => {
        return api.post(
          `/employees/${employee_id}/portfolio/sort`,
          { items },
          { multipart: true },
        );
      },
    },

    {
      name: 'activate_portfolio_image',
      description:
        'Make a single portfolio image visible on the customer-facing employee profile. CONFIRM first.',
      inputSchema: z.object({
        employee_id: idLike,
        image_id: idLike,
      }),
      handler: async ({ employee_id, image_id }) => {
        return api.post(`/employees/${employee_id}/portfolio/${image_id}/activate`);
      },
    },

    {
      name: 'deactivate_portfolio_image',
      description:
        'Hide a single portfolio image (kept in storage, removed from the public profile). CONFIRM first.',
      inputSchema: z.object({
        employee_id: idLike,
        image_id: idLike,
      }),
      handler: async ({ employee_id, image_id }) => {
        return api.post(`/employees/${employee_id}/portfolio/${image_id}/deactivate`);
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — branches (Phase C — NEW for create/update/activate)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'create_branch',
      description:
        'Create a new branch. Backend requirements:\n• `name` (Arabic name, ≥2)\n• `manager_id` (User id of the branch manager — typically the vendor user themselves; call get_profile to find the user id)\n• `country_id`, `region_id`, `city_id` — IDs from the `/v1/countries`, `/v1/regions`, `/v1/cities` global endpoints (not exposed through this MCP yet — ask the vendor for the city name and look up the id in a follow-up if needed)\n• `address` text\n• `lat` and `long` as STRINGS\n• `official_hours` — array of `{ day, start_time, end_time }` for every working day\n\nMost vendors create branches through the dashboard, so this tool is for advanced "add a new shop through the chat" flows. CONFIRM every field.',
      inputSchema: z.object({
        name: z.string().min(2),
        manager_id: idLike,
        country_id: idLike,
        region_id: idLike,
        city_id: idLike,
        address: z.string().min(2),
        lat: z.string().min(2),
        long: z.string().min(2),
        official_hours: z.array(officialHourSchema).min(1),
      }),
      handler: async (input) => {
        return api.post('/branches', input, { multipart: true });
      },
    },

    {
      name: 'update_branch',
      description:
        'Update an existing branch. Every field optional — reads the current branch first and merges your edits. Backend\'s BranchRequest still enforces `official_hours` + `name` + lat/long etc. on PUT, so the MCP echoes the current values back when you don\'t supply new ones. CONFIRM the diff.',
      inputSchema: z.object({
        id: idLike,
        name: z.string().min(2).optional(),
        manager_id: idLike.optional(),
        country_id: idLike.optional(),
        region_id: idLike.optional(),
        city_id: idLike.optional(),
        address: z.string().min(2).optional(),
        lat: z.string().min(2).optional(),
        long: z.string().min(2).optional(),
        official_hours: z.array(officialHourSchema).optional(),
      }),
      handler: async (input) => {
        const current = await api.get(`/branches/${input.id}`);
        const currentOfficialHours = Array.isArray(current.official_hours)
          ? current.official_hours.map((h: any) => ({
              day: h.day,
              start_time: h.start_time,
              end_time: h.end_time,
            }))
          : [];
        const payload: Record<string, any> = {
          name: input.name ?? current.name ?? '',
          manager_id:
            input.manager_id ?? current.manager?.id ?? current.manager_id,
          country_id:
            input.country_id ?? current.country?.id ?? current.country_id,
          region_id:
            input.region_id ?? current.region?.id ?? current.region_id,
          city_id: input.city_id ?? current.city?.id ?? current.city_id,
          address: input.address ?? current.address ?? '',
          lat: input.lat ?? String(current.lat ?? ''),
          long: input.long ?? String(current.long ?? ''),
          official_hours:
            input.official_hours && input.official_hours.length > 0
              ? input.official_hours
              : currentOfficialHours,
        };
        return api.putViaPost(`/branches/${input.id}`, payload, {
          multipart: true,
        });
      },
    },

    {
      name: 'activate_branch',
      description:
        'Make a branch visible to customers and accept new bookings. CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/branches/${id}/activate`),
    },

    {
      name: 'deactivate_branch',
      description:
        'Hide a branch from the customer-facing storefront and block new bookings on it. Existing bookings stay intact; only customer-side selection is blocked. CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/branches/${id}/deactivate`),
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — cancellation reasons (Phase B — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'create_cancellation_reason',
      description:
        'Add a new cancellation reason to the vendor\'s curated list. Required: `reason_ar` (2-500 chars). Optional: `reason_en`, `sort` (0-127). The MCP does NOT need to be told the vendor_id — the backend sets it server-side from the auth token. CONFIRM with the vendor first.',
      inputSchema: z.object({
        reason_ar: z.string().min(2).max(500),
        reason_en: z.string().min(2).max(500).optional(),
        sort: z.number().int().min(0).max(127).optional(),
      }),
      handler: async (input) => {
        return api.post('/cancellation-reasons', clean(input), {
          multipart: true,
        });
      },
    },

    {
      name: 'update_cancellation_reason',
      description:
        'Update a cancellation reason\'s text or sort order. The `is_active` flag is NOT settable here — use activate / deactivate instead.',
      inputSchema: z.object({
        id: idLike,
        reason_ar: z.string().min(2).max(500).optional(),
        reason_en: z.string().min(2).max(500).optional(),
        sort: z.number().int().min(0).max(127).optional(),
      }),
      handler: async (input) => {
        const payload: Record<string, any> = {};
        if (input.reason_ar) payload.reason_ar = input.reason_ar;
        if (input.reason_en) payload.reason_en = input.reason_en;
        if (input.sort !== undefined) payload.sort = input.sort;
        return api.putViaPost(`/cancellation-reasons/${input.id}`, payload, {
          multipart: true,
        });
      },
    },

    {
      name: 'activate_cancellation_reason',
      description:
        'Re-enable a cancellation reason so it appears in the customer cancel picker. CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/cancellation-reasons/${id}/activate`),
    },

    {
      name: 'deactivate_cancellation_reason',
      description:
        'Hide a cancellation reason from the customer cancel picker (kept in storage, bookings that already used it still surface the text). CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/cancellation-reasons/${id}/deactivate`),
    },

    {
      name: 'sort_cancellation_reasons',
      description:
        'Bulk reorder the cancellation reasons. Pass `items: [{ id, sort }, ...]` — lower sort = top of the picker. The backend validates that every id belongs to the calling vendor before applying the reorder. CONFIRM with the vendor first.',
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              id: idLike,
              sort: z.number().int().min(0).max(127),
            }),
          )
          .min(1),
      }),
      handler: async ({ items }) => {
        return api.post(
          '/cancellation-reasons/sort',
          { items },
          { multipart: true },
        );
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — settings (Phase B — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'update_settings',
      description:
        'Update the vendor\'s storefront settings.\n• `booking_differance` — minutes of lead time required before customers can book (≥0). 0 means "book anytime up to right now".\n• `calender_differance` — calendar grid resolution in minutes (5-30).\n• `cancel_booking` — 0 to block customer self-cancel, 1 to allow.\n• `reviews_enabled` (optional) — 0 to disable customer review CTA + vendor dashboard, 1 to enable.\n• `terms` (optional) — terms-and-conditions blurb shown at booking. Min 3 chars.\n\nBackend requires booking_differance, calender_differance, and cancel_booking on every PUT. Reads the current settings first and merges your edits. CONFIRM the diff.',
      inputSchema: z.object({
        booking_differance: z.number().int().min(0).optional(),
        calender_differance: z.number().int().min(5).max(30).optional(),
        cancel_booking: z.boolean().optional(),
        reviews_enabled: z.boolean().optional(),
        terms: z.string().min(3).optional(),
      }),
      handler: async (input) => {
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
        if (input.reviews_enabled !== undefined) {
          payload.reviews_enabled = bool01(input.reviews_enabled);
        } else if (current.reviews_enabled !== undefined) {
          payload.reviews_enabled = current.reviews_enabled;
        }
        if (input.terms) payload.terms = input.terms;
        else if (current.terms) payload.terms = current.terms;
        return api.putViaPost('/settings', payload, { multipart: true });
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — promo codes (Phase B — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'create_promo_code',
      description:
        'Create a new promo code.\n• `code` (optional) — alphanumeric ASCII, ≥5 chars, must be unique platform-wide. If omitted, the backend auto-generates one.\n• `discount_type` (required) — `percentage` or `fixed`.\n• `value` (required, ≥0) — percent (0-100) or fixed SAR amount depending on `discount_type`.\n• `start_date` and `end_date` (required, end after start) — YYYY-MM-DD.\n• `uses` (required) — total redemption cap (≥1).\n\nCONFIRM the full payload before calling.',
      inputSchema: z.object({
        code: z
          .string()
          .min(5)
          .regex(/^[A-Za-z0-9]+$/, 'Alphanumeric ASCII only.')
          .optional(),
        discount_type: z.enum(['percentage', 'fixed']),
        value: z.number().nonnegative(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        uses: z.number().int().min(1),
      }),
      handler: async (input) => {
        return api.post('/promo-codes', clean(input), { multipart: true });
      },
    },

    {
      name: 'update_promo_code',
      description:
        'Update a promo code\'s value / dates / cap. Every field optional. CONFIRM the diff with the vendor before calling.',
      inputSchema: z.object({
        id: idLike,
        code: z
          .string()
          .min(5)
          .regex(/^[A-Za-z0-9]+$/)
          .optional(),
        discount_type: z.enum(['percentage', 'fixed']).optional(),
        value: z.number().nonnegative().optional(),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        uses: z.number().int().min(1).optional(),
      }),
      handler: async (input) => {
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
      },
    },

    {
      name: 'activate_promo_code',
      description:
        'Re-enable a promo code (is_active = 1). CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/promo-codes/${id}/activate`),
    },

    {
      name: 'deactivate_promo_code',
      description:
        'Disable a promo code (is_active = 0). Existing bookings that used it keep their discount; only new redemptions are blocked. CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/promo-codes/${id}/deactivate`),
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — ZATCA (Phase C — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'update_zatca',
      description:
        'Update the vendor\'s ZATCA registration metadata. Required: `seller_name_en`, `seller_name_ar`, `tax_number` (numeric), `address`. Use after register_zatca succeeds when the vendor needs to amend their tax profile. CONFIRM every field.',
      inputSchema: z.object({
        seller_name_en: z.string().min(2),
        seller_name_ar: z.string().min(2),
        tax_number: z.union([z.string(), z.number()]),
        address: z.string().min(2),
      }),
      handler: async (input) => {
        return api.putViaPost('/zatca', input, { multipart: true });
      },
    },

    {
      name: 'register_zatca',
      description:
        'Register the vendor with ZATCA. Required: `environment` (`sandbox` or `production`) and a 6-digit `otp` from the ZATCA Fatoora portal. The vendor MUST have already filled in their seller name / tax number / address via update_zatca (or the dashboard) before this call succeeds.\n\n**This is a one-time onboarding step. CONFIRM every field with the vendor before calling — registering in production is irreversible.**',
      inputSchema: z.object({
        environment: z.enum(['sandbox', 'production']),
        otp: z
          .string()
          .regex(/^\d{6}$/)
          .describe('The 6-digit OTP issued by the ZATCA Fatoora portal.'),
      }),
      handler: async (input) => {
        return api.post('/zatca/register', input, { multipart: true });
      },
    },

    {
      name: 'activate_zatca',
      description:
        'Toggle ZATCA phase-2 ON. After this, every completed booking generates a real tax invoice (with QR + cryptographic stamp) submitted to ZATCA. Requires the vendor to be `registered` first. CONFIRM.',
      inputSchema: z.object({}),
      handler: async () => api.post('/zatca/activate'),
    },

    {
      name: 'deactivate_zatca',
      description:
        'Toggle ZATCA phase-2 OFF. The vendor will still appear registered (history preserved) but new bookings stop issuing tax invoices. Useful when the vendor is closing or switching tax models. CONFIRM.',
      inputSchema: z.object({}),
      handler: async () => api.post('/zatca/deactivate'),
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — roles (Phase C — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'create_role',
      description:
        'Create a new vendor-scoped role with a permissions list. Use list_permissions to discover the available permission names. Required: `name` (Arabic OK), `permissions` (array of permission name strings). CONFIRM first.',
      inputSchema: z.object({
        name: z.string().min(2),
        permissions: z.array(z.string()).min(1),
      }),
      handler: async (input) => {
        return api.post('/roles', input, { multipart: true });
      },
    },

    {
      name: 'update_role',
      description:
        'Update a role\'s name and/or permissions list. Reads the current role first. CONFIRM the diff before calling.',
      inputSchema: z.object({
        id: idLike,
        name: z.string().min(2).optional(),
        permissions: z.array(z.string()).optional(),
      }),
      handler: async (input) => {
        const current = await api.get(`/roles/${input.id}`);
        const currentPermissions: string[] = Array.isArray(current.permissions)
          ? current.permissions.map((p: any) =>
              typeof p === 'string' ? p : p.name,
            )
          : [];
        const payload: Record<string, any> = {
          name: input.name ?? current.name ?? '',
          permissions:
            input.permissions && input.permissions.length > 0
              ? input.permissions
              : currentPermissions,
        };
        return api.putViaPost(`/roles/${input.id}`, payload, {
          multipart: true,
        });
      },
    },

    {
      name: 'activate_role',
      description: 'Mark a role active. CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/roles/${id}/activate`),
    },

    {
      name: 'deactivate_role',
      description: 'Mark a role inactive. CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/roles/${id}/deactivate`),
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — reminders + channels (Phase D — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'update_reminder',
      description:
        'Update one reminder configuration. Lets the vendor tweak when (minutes_before) and through which channels a booking reminder fires.',
      inputSchema: z.object({
        id: idLike,
        minutes_before: z.number().int().min(0).optional(),
        channels: z
          .array(idLike)
          .optional()
          .describe('Array of reminder-channel ids that should deliver this reminder.'),
      }),
      handler: async (input) => {
        const payload: Record<string, any> = {};
        if (input.minutes_before !== undefined) {
          payload.minutes_before = input.minutes_before;
        }
        if (input.channels) payload.channels = input.channels;
        return api.putViaPost(`/reminders/${input.id}`, payload, {
          multipart: true,
        });
      },
    },

    {
      name: 'activate_reminder',
      description: 'Turn a specific reminder configuration ON. CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/reminders/${id}/activate`),
    },

    {
      name: 'deactivate_reminder',
      description: 'Turn a specific reminder configuration OFF. CONFIRM first.',
      inputSchema: z.object({ id: idLike }),
      handler: async ({ id }) => api.post(`/reminders/${id}/deactivate`),
    },

    {
      name: 'update_reminder_channels',
      description:
        'Toggle which reminder channels (SMS / Email / Push / WhatsApp) are enabled for this vendor. Pass `channels: [{ id, is_active }, ...]` for each channel you want to toggle. Reads the current channel list first; you only need to include the channels you\'re changing.',
      inputSchema: z.object({
        channels: z
          .array(
            z.object({
              id: idLike,
              is_active: z.boolean(),
            }),
          )
          .min(1),
      }),
      handler: async ({ channels }) => {
        const payload = {
          channels: (channels as Array<{ id: any; is_active: boolean }>).map(
            (c) => ({
              id: c.id,
              is_active: bool01(c.is_active),
            }),
          ),
        };
        return api.putViaPost('/reminder-channels', payload, {
          multipart: true,
        });
      },
    },

    // ════════════════════════════════════════════════════════════════
    //  WRITE — account management (Phase D — NEW)
    // ════════════════════════════════════════════════════════════════

    {
      name: 'change_password',
      description:
        'Change the vendor account password. Requires the current password and the new password (≥8 chars). CONFIRM with the user before calling.',
      inputSchema: z.object({
        current_password: z.string(),
        new_password: z.string().min(8),
        new_password_confirmation: z.string().min(8).optional(),
      }),
      handler: async (input) => {
        const payload: Record<string, any> = {
          current_password: input.current_password,
          new_password: input.new_password,
          new_password_confirmation:
            input.new_password_confirmation ?? input.new_password,
        };
        return api.post('/change-password', payload, { multipart: true });
      },
    },

    {
      name: 'send_code',
      description:
        'Request a 6-digit verification code be sent to the vendor (typically by SMS / email) — used before update_email or update_phone to verify control of the new contact. Backend determines the delivery channel from the request.',
      inputSchema: z.object({}),
      handler: async () => api.post('/send-code'),
    },

    {
      name: 'update_email',
      description:
        'Change the vendor account email. Requires a verification `code` (from send_code) and the new `email`. CONFIRM with the user before calling.',
      inputSchema: z.object({
        email: z.string().email(),
        code: z.string().regex(/^\d{6}$/),
      }),
      handler: async (input) => {
        return api.post('/update-email', input, { multipart: true });
      },
    },

    {
      name: 'update_phone',
      description:
        'Change the vendor account phone. Requires a verification `code` (from send_code) and the new `phone` (digits only, no + prefix). CONFIRM with the user before calling.',
      inputSchema: z.object({
        phone: z.string().min(7),
        code: z.string().regex(/^\d{6}$/),
      }),
      handler: async (input) => {
        return api.post('/update-phone', input, { multipart: true });
      },
    },

    {
      name: 'update_profile',
      description:
        'Update the vendor profile fields that aren\'t email / phone / password (those have their own dedicated tools because they require an OTP). Typical use: change the display name, social handles, profile image URL. The exact accepted fields depend on ProfileRequest on the backend — pass whatever the user wants to change and the backend ignores unknown keys.',
      inputSchema: z.object({
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
        return api.post('/update-profile', clean(input), { multipart: true });
      },
    },
  ];
}
