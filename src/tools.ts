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
 * Phase-1 surface: reads + the most common write operations vendors
 * actually ask for in conversation (cancel a booking, mark it
 * completed, change a service price). Heavier writes (create
 * branch/employee, full service edit, ZATCA flow) wait for phase 2.
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
  const VAT_KEYS = ['vat', 'total_vat', 'tax', 'total_tax', 'vat_value', 'vat_percentage'];
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
  stripList(cloned.services);
  return cloned;
}

export function buildTools(api: VendorClient): ToolDef[] {
  return [
    // ────────────────────────────────────────────────────────────
    //  READ TOOLS
    // ────────────────────────────────────────────────────────────

    {
      name: 'get_profile',
      description:
        'Get the logged-in vendor account profile: name, email, phone, role, active subscription summary, and social links. Use this first when the user asks "who am I" / "what plan am I on" / "what\'s my account info".\n\n**GLOBAL CONVENTIONS FOR ALL TOOLS IN THIS SERVER:**\n• **Timezone:** the vendor operates in Saudi Arabia (Asia/Riyadh, UTC+3, no DST). When the user says "today" / "tomorrow" / "this evening" / "اليوم" / "بكره" they mean Saudi-local. NEVER guess or compute unix timestamps in your head — first call `get_current_time` to get the actual Saudi date, then pass `local_datetime` (YYYY-MM-DD HH:MM Saudi local) to booking tools and let the server convert. Manual timestamp math has already created off-by-a-week bugs.\n• **Numeric ids** (id, branch_id, employee_id, service_id, customer_id, user_id, etc.) are for YOUR follow-up tool calls only. Never include them in your reply to the user. Refer to entities by their human-readable names ("سمير" not "سمير id=10", "حلاق النخيل" not "branch 3", "حلاقة شعر للأطفال" not "service id=22").\n• **VAT / tax** numbers (vat, total_vat, tax) are stripped from booking responses when the vendor is not ZATCA-active. If a booking response has no VAT fields, the vendor cannot issue tax invoices — do not invent, mention, or compute tax in your reply.',
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
          clean({ without_pagination: without_pagination ? 'true' : undefined }),
        );
      },
    },

    {
      name: 'list_bookings',
      description:
        'List bookings. Supports filtering by branch_id, employee_id, status (`confirmed`, `completed`, `canceled`, `missed`, `not_confirmed`), and a specific date (YYYY-MM-DD — matched against `start_time`). Returns paginated bookings with customer name, services, employee, time, status, payment, and total. Use this for "show me today\'s bookings", "what bookings does ahmad have this week", "any canceled bookings in فرع النخيل".\n\n**Do NOT mention internal id fields (id, employee_id, branch_id, etc.) to the user in your replies — they are implementation details. Use the human-readable names (customer name, employee name, branch name, time).**\n\n**VAT fields (vat, total_vat, tax) are AUTOMATICALLY STRIPPED from the response when the vendor is not ZATCA-active. If you don\'t see VAT fields, the vendor has no tax invoices — don\'t invent or display tax numbers.**',
      inputSchema: z.object({
        branch_id: z.union([z.number(), z.string()]).optional(),
        employee_id: z.union([z.number(), z.string()]).optional(),
        status: z
          .enum(['confirmed', 'completed', 'canceled', 'missed', 'not_confirmed'])
          .optional(),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD. Backend matches against booking start_time.'),
        q: z.string().optional().describe('Free-text search (customer name / id).'),
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
        'Get full detail for a single booking by id: customer, services (with per-line price + commission), employee, branch, status, payment, total, promo code applied, notes, full status update history (timeline of who changed what when). Use this when the user references a specific booking number or you need to know who served which booking.\n\n**Do NOT mention internal id fields (id, employee_id, branch_id, etc.) to the user in your replies — they are implementation details. Use the human-readable names (customer name, employee name, branch name, time).**\n\n**VAT fields (vat, total_vat, tax) are AUTOMATICALLY STRIPPED from the response when the vendor is not ZATCA-active. The backend pre-computes VAT for every booking regardless of ZATCA status, but those numbers are meaningless when no tax invoice was issued. If the response has no VAT keys, the vendor is in non-VAT mode — do not invent, display, or sum VAT in your reply to the user.**',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
      }),
      handler: async ({ id }) => {
        const [booking, zatca] = await Promise.all([
          api.get(`/bookings/${id}`),
          api.getZatcaState(),
        ]);
        return zatca.active ? booking : stripVatFields(booking);
      },
    },

    {
      name: 'list_services',
      description:
        'List services in the vendor\'s catalog. Optional filters: branch_id, section_id, is_active, free-text q. Returns id, name_ar, price, service_time (minutes), discount, featured flag, sections, branches. Use this before update_service so you have the service id, or whenever the user asks about pricing / what services exist.\n\n**The numeric ids in the response are for YOUR follow-up tool calls — never include them in your reply to the user. Refer to services by name only.**',
      inputSchema: z.object({
        branch_id: z.union([z.number(), z.string()]).optional(),
        section_id: z.union([z.number(), z.string()]).optional(),
        is_active: z.enum(['0', '1']).optional(),
        q: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/services', clean(input));
      },
    },

    {
      name: 'list_employees',
      description:
        'List employees with branches, job title, services count, bookings count. Optional filters: branch_id, q. Use this when the user mentions an employee by name to map it to an employee id, or to answer "كم موظف عندي / how many staff do I have".\n\n**The numeric ids in the response are for YOUR follow-up tool calls — never include them in your reply to the user. Refer to employees by name only (e.g. "سمير" not "سمير (id=10)").**',
      inputSchema: z.object({
        branch_id: z.union([z.number(), z.string()]).optional(),
        q: z.string().optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/employees', clean(input));
      },
    },

    {
      name: 'get_reports',
      description:
        'Pull aggregated KPIs (revenue, bookings_count, AOV) for a given period. Supported periods: `day` (today), `week` (this week), `month` (this month), `year`. Optional branch_id / employee_id to narrow. Returns the same payload the home dashboard reads. Use for "كم دخلي اليوم / how much did I make this week / show me month-to-date".',
      inputSchema: z.object({
        period: z.enum(['day', 'week', 'month', 'year']).default('month'),
        branch_id: z.union([z.number(), z.string()]).optional(),
        employee_id: z.union([z.number(), z.string()]).optional(),
      }),
      handler: async (input) => {
        return api.get('/reports', clean({ type: 'home', ...input }));
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
      name: 'get_wallet',
      description:
        'Get the vendor wallet balance + recent transactions. Optional branch_id. Use for "كم في محفظتي / what\'s my balance".',
      inputSchema: z.object({
        branch_id: z.union([z.number(), z.string()]).optional(),
        per_page: z.number().int().min(1).max(50).optional(),
      }),
      handler: async (input) => {
        return api.get('/wallet', clean(input));
      },
    },

    // ────────────────────────────────────────────────────────────
    //  WRITE TOOLS
    //
    //  All writes require explicit user confirmation in the model
    //  layer — Claude is instructed (via the server's system prompt
    //  at the MCP layer + each tool description) to repeat back the
    //  exact change and wait for "yes" before invoking these.
    // ────────────────────────────────────────────────────────────

    {
      name: 'cancel_booking',
      description:
        'Cancel a booking by id. Sets status to `canceled`. REFUSES if the booking is already `completed` (the invoice is issued and reports are balanced — completed bookings are final at this layer). CONFIRM with the user before calling — display the booking detail first via get_booking and ask "هل أكدت الإلغاء؟" or equivalent. Returns the updated booking.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
      }),
      handler: async ({ id }) => {
        const detail = await api.get(`/bookings/${id}`);
        ensureNotCompleted(detail, 'cancel');
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
            Math.floor(new Date(String(detail.start_time).replace(' ', 'T')).getTime() / 1000),
          notes: detail.notes || '',
          status: 'canceled',
          service_ids: (detail.booking_items || detail.services || [])
            .map((s: any) => s.service_id ?? s.id)
            .filter((x: any) => x != null),
        };
        return api.putViaPost(`/bookings/${id}`, clean(payload), { multipart: true });
      },
    },

    {
      name: 'complete_booking',
      description:
        'Mark a booking as completed (customer showed + service delivered). Sets status `completed` AND payment_status=1 automatically — that mirrors the mobile app\'s "إتمام البيع" flow. REFUSES if the booking is already completed (no-op). CONFIRM before calling. Returns the updated booking.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
      }),
      handler: async ({ id }) => {
        const detail = await api.get(`/bookings/${id}`);
        ensureNotCompleted(detail, 're-complete');
        const payload: Record<string, any> = {
          branch_id: detail.branch?.id ?? detail.branch_id,
          employee_id: detail.employee?.id ?? detail.employee_id,
          customer_id: existingCustomerId(detail),
          payment_way: detail.payment_way || 'cash',
          payment_status: 1,
          start_time: detail.start_time,
          booking_timestamp:
            detail.booking_timestamp ||
            Math.floor(new Date(String(detail.start_time).replace(' ', 'T')).getTime() / 1000),
          notes: detail.notes || '',
          status: 'completed',
          service_ids: (detail.booking_items || detail.services || [])
            .map((s: any) => s.service_id ?? s.id)
            .filter((x: any) => x != null),
        };
        return api.putViaPost(`/bookings/${id}`, clean(payload), { multipart: true });
      },
    },

    {
      name: 'reschedule_booking',
      description:
        'Move an existing booking to a new start time (and optionally a different employee). Backend recomputes end_time from the service durations. REFUSES if the booking is already completed (you can\'t move a transaction that already happened).\n\n**TIMEZONE — READ THIS:** Pass the new time as `local_datetime` ({ date: "YYYY-MM-DD", time: "HH:MM" } in Saudi local — Asia/Riyadh UTC+3). The server converts to unix for you. DO NOT compute unix timestamps in your head; previous attempts landed bookings several days off. If you need today\'s Saudi date, call `get_current_time` first.\n\nCONFIRM before calling — repeat back the booking, the old time, and the new time to the user before invoking.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
        local_datetime: z
          .object({
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .describe('YYYY-MM-DD (Saudi local).'),
            time: z
              .string()
              .regex(/^\d{1,2}:\d{2}$/)
              .describe('HH:MM 24h (Saudi local). e.g. "21:00" for 9 PM.'),
          })
          .optional()
          .describe('PREFERRED. Saudi-local datetime — server converts.'),
        booking_timestamp: z
          .number()
          .int()
          .optional()
          .describe('ADVANCED — only if you already have a verified unix.'),
        employee_id: z
          .union([z.number(), z.string()])
          .optional()
          .describe('Override the employee if reassigning at the same time.'),
      }),
      handler: async ({ id, local_datetime, booking_timestamp, employee_id }) => {
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

        return api.post(
          `/bookings/${id}/reschedule`,
          clean({ booking_timestamp: timestamp, employee_id }),
          { multipart: true },
        );
      },
    },

    {
      name: 'update_service_price',
      description:
        'Update ONLY the price (and optionally service_time / featured) of a service. Heavier edits (name, description, branches, section) belong to a future `update_service` tool — this one is scoped tight on purpose so vendors can say "ارفع سعر الحلاقة لـ 45 ريال" and the change is unambiguous. CONFIRM before calling. Reads the service first so the rest of the payload (name_ar, description_ar, section_id, branch_id, etc.) is preserved.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
        price: z.number().nonnegative(),
        service_time: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Service duration in minutes (optional).'),
        featured: z
          .boolean()
          .optional()
          .describe('Optional featured flag.'),
      }),
      handler: async ({ id, price, service_time, featured }) => {
        const current = await api.get(`/services/${id}`);
        const branchIds: any[] = Array.isArray(current.branches)
          ? current.branches.map((b: any) => b.id ?? b)
          : current.branch_id
            ? [current.branch_id]
            : [];
        const payload: Record<string, any> = {
          // Echo the existing names/descriptions — the FormRequest
          // requires the Arabic name + description on every update,
          // even when you're only changing the price.
          name_ar: current.name_ar || current.name || '',
          name_en: current.name_en || 'dummy_name_en',
          description_ar: current.description_ar || current.description || '-',
          description_en: current.description_en || 'dummy_descriptions_en',
          section_id: current.section?.id ?? current.section_id,
          price,
          service_time: service_time ?? current.service_time ?? 30,
          featured:
            featured === undefined ? (current.featured ? '1' : '0') : featured ? '1' : '0',
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
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
      }),
      handler: async ({ id }) => {
        return api.post(`/services/${id}/activate`);
      },
    },

    {
      name: 'deactivate_service',
      description:
        'Hide a service from customers (`is_active = 0`). The service stays in the catalog and historical bookings keep working — only NEW customer-side selection is blocked. CONFIRM before calling.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
      }),
      handler: async ({ id }) => {
        return api.post(`/services/${id}/deactivate`);
      },
    },

    // ────────────────────────────────────────────────────────────
    //  PHASE 2 — creates + full updates
    //
    //  Phase 1 covered the everyday vendor questions ("how much
    //  today / cancel this booking / change a price"). Phase 2 adds
    //  the create/edit surface so a vendor can onboard new bookings,
    //  services, employees, customers, and offers purely through
    //  conversation. Same confirm-before-write contract — every
    //  write tool's description ends with CONFIRM before calling.
    // ────────────────────────────────────────────────────────────

    // ── Sections ─────────────────────────────────────────────────

    {
      name: 'list_sections',
      description:
        'List service sections (the groupings shown above the services tab in the app: "قسم شعر", "قسم لحية", etc.). Each section carries an id + name_ar and its nested services. Defaults to without_pagination=true so the caller gets the full list back in one shot — that\'s what create_service / catalog flows need. Pass without_pagination=false for the paginated index.',
      inputSchema: z.object({
        branch_id: z.union([z.number(), z.string()]).optional(),
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
      name: 'create_section',
      description:
        'Create a new service section. The backend ONLY accepts `name_ar` (required, ≥2 chars) and `description_ar` (optional). Do NOT send branch_id — the FormRequest does not include it and adding it confuses the request. CONFIRM the name with the user before calling.',
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

    // ── Services (full create / update) ──────────────────────────

    {
      name: 'create_service',
      description:
        'Create a new service. Required: name_ar (≥2), description_ar (≥2), price, service_time (minutes), section_id, branch_id (one or more — array). Optional: extra_time (minutes), featured (boolean). The backend\'s English columns are quirky (validator is nullable|min:2 but the long-standing web behaviour sends "dummy_name_en" / "dummy_descriptions_en" placeholders), so we send those automatically — the user only thinks in Arabic. CONFIRM the full payload before calling.',
      inputSchema: z.object({
        name_ar: z.string().min(2),
        description_ar: z.string().min(2),
        price: z.number().nonnegative(),
        service_time: z.number().int().positive().describe('Duration in minutes.'),
        section_id: z.union([z.number(), z.string()]),
        branch_id: z
          .array(z.union([z.number(), z.string()]))
          .min(1)
          .describe(
            'One or more branch ids. MUST be an array — the backend rejects a single scalar.',
          ),
        extra_time: z.number().int().nonnegative().optional(),
        featured: z.boolean().optional(),
      }),
      handler: async (input) => {
        const payload: Record<string, any> = {
          name_ar: input.name_ar,
          name_en: 'dummy_name_en',
          description_ar: input.description_ar,
          description_en: 'dummy_descriptions_en',
          price: input.price,
          service_time: input.service_time,
          section_id: input.section_id,
          branch_id: input.branch_id,
        };
        if (input.extra_time !== undefined) payload.extra_time = input.extra_time;
        if (input.featured !== undefined) payload.featured = input.featured ? '1' : '0';
        return api.post('/services', payload, { multipart: true });
      },
    },

    {
      name: 'update_service',
      description:
        'Full service update — name, description, price, duration, section, branches, featured flag. Use this when the user wants to change MORE than just the price (for that, use update_service_price). Reads the current service first so you can omit any field you don\'t want to change. CONFIRM the full diff before calling.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
        name_ar: z.string().min(2).optional(),
        description_ar: z.string().min(2).optional(),
        price: z.number().nonnegative().optional(),
        service_time: z.number().int().positive().optional(),
        extra_time: z.number().int().nonnegative().optional(),
        section_id: z.union([z.number(), z.string()]).optional(),
        branch_id: z.array(z.union([z.number(), z.string()])).optional(),
        featured: z.boolean().optional(),
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
          name_en: current.name_en || 'dummy_name_en',
          description_ar:
            input.description_ar ?? current.description_ar ?? current.description ?? '-',
          description_en: current.description_en || 'dummy_descriptions_en',
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
        if (featuredVal !== undefined) {
          payload.featured = featuredVal ? '1' : '0';
        }
        return api.putViaPost(`/services/${input.id}`, payload, { multipart: true });
      },
    },

    // ── Bookings (create / notes / no-show) ──────────────────────

    {
      name: 'create_booking',
      description:
        'Create a new booking.\n\nRequired: branch_id, employee_id, service_ids (array), AND ONE OF { `local_datetime` (preferred) OR `booking_timestamp` (advanced) }.\n\n**TIMEZONE — READ THIS:** The vendor is in Saudi Arabia (Asia/Riyadh, UTC+3). Use the `local_datetime` field with Saudi-local time as `{ date: "YYYY-MM-DD", time: "HH:MM" }` and the server converts to the correct unix instant for you. DO NOT compute unix timestamps in your head — it goes wrong (a previous booking ended up six days early because of this). If you need to know today\'s date in Saudi, call `get_current_time` first.\n\n**`customer_id` is OPTIONAL** — if the user doesn\'t mention a specific customer, OMIT this field entirely. The backend treats `customer_id: null` as a "walk-in / auto-customer" booking which is a perfectly valid state (the mobile POS uses this every time a vendor rings up a walk-in). Do NOT ask the user "which customer?" when they didn\'t mention one — go ahead and create the booking without it. The booking will display as "عميل تلقائي" (auto-customer) in the UI.\n\nWhen `customer_id` IS provided, it must be the User table id (not the Customer table id). Use list_customers and read the `id` field from a result, OR create_customer first and use the returned id.\n\nOther optional fields: notes, payment_way (`cash`/`online`, default cash), status (default `confirmed`), payment_status (0 unpaid / 1 paid; default 0). Use list_branches → list_employees → list_services first to gather the required ids. CONFIRM the full booking before creating.',
      inputSchema: z.object({
        branch_id: z.union([z.number(), z.string()]),
        employee_id: z.union([z.number(), z.string()]),
        customer_id: z
          .union([z.number(), z.string()])
          .optional()
          .describe(
            'OPTIONAL — omit for walk-in / auto-customer bookings. User table id (not Customer table id) when provided.',
          ),
        service_ids: z.array(z.union([z.number(), z.string()])).min(1),
        local_datetime: z
          .object({
            date: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .describe('YYYY-MM-DD (Saudi local). e.g. "2026-05-23".'),
            time: z
              .string()
              .regex(/^\d{1,2}:\d{2}$/)
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
      }),
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
          service_ids: input.service_ids,
          booking_timestamp: timestamp,
          payment_way: input.payment_way || 'cash',
          status: input.status || 'confirmed',
          payment_status: input.payment_status ?? 0,
          notes: input.notes || '',
          future_booking: input.status === 'completed' ? 0 : 1,
        };
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
      name: 'update_booking_notes',
      description:
        'Append or replace the notes on a booking without touching anything else. Pass `mode: "append"` to add to existing notes (separator: newline) or `mode: "replace"` (default) to overwrite. Notes-only edits are ALLOWED on completed bookings (they\'re metadata, not status) — useful for adding a post-service comment like "customer asked for shorter sides next time".',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
        notes: z.string(),
        mode: z.enum(['append', 'replace']).optional(),
      }),
      handler: async ({ id, notes, mode }) => {
        const detail = await api.get(`/bookings/${id}`);
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
            Math.floor(new Date(String(detail.start_time).replace(' ', 'T')).getTime() / 1000),
          notes: nextNotes,
          service_ids: (detail.booking_items || detail.services || [])
            .map((s: any) => s.service_id ?? s.id)
            .filter((x: any) => x != null),
        };
        return api.putViaPost(`/bookings/${id}`, clean(payload), { multipart: true });
      },
    },

    {
      name: 'mark_no_show',
      description:
        'Mark a booking as `missed` (customer didn\'t show up). Same shape as cancel_booking but the status semantics are different — `missed` does not refund the slot in reports. REFUSES if the booking is already completed. CONFIRM before calling.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
      }),
      handler: async ({ id }) => {
        const detail = await api.get(`/bookings/${id}`);
        ensureNotCompleted(detail, 'mark as no-show');
        const payload: Record<string, any> = {
          branch_id: detail.branch?.id ?? detail.branch_id,
          employee_id: detail.employee?.id ?? detail.employee_id,
          customer_id: existingCustomerId(detail),
          payment_way: detail.payment_way || 'cash',
          payment_status: detail.payment_status ?? 0,
          start_time: detail.start_time,
          booking_timestamp:
            detail.booking_timestamp ||
            Math.floor(new Date(String(detail.start_time).replace(' ', 'T')).getTime() / 1000),
          notes: detail.notes || '',
          status: 'missed',
          service_ids: (detail.booking_items || detail.services || [])
            .map((s: any) => s.service_id ?? s.id)
            .filter((x: any) => x != null),
        };
        return api.putViaPost(`/bookings/${id}`, clean(payload), { multipart: true });
      },
    },

    // ── Customers ────────────────────────────────────────────────

    {
      name: 'get_customer',
      description:
        'Get full customer detail by id — name, contact info, total bookings, last visit, branches visited. Use when the user references a specific customer by id or after list_customers to drill down.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
      }),
      handler: async ({ id }) => {
        return api.get(`/customers/${id}`);
      },
    },

    {
      name: 'create_customer',
      description:
        'Create a new customer record. Backend auto-links to an existing User row if phone/email already exists in the platform. Required: first_name. Recommended: phone (digits only, e.g. 0501234567). Optional: last_name, email. NOTE: this endpoint takes JSON, not multipart — diverging from the rest of the API. CONFIRM the contact info before calling.',
      inputSchema: z.object({
        first_name: z.string().min(1),
        last_name: z.string().optional(),
        phone: z
          .string()
          .optional()
          .describe('Digits only (e.g. "0501234567"). Strip + and country code first.'),
        email: z.string().email().optional(),
      }),
      handler: async (input) => {
        // /customers POST is JSON not multipart — this is the one
        // endpoint that differs from the standard write pattern.
        return api.post('/customers', clean(input));
      },
    },

    // ── Employees ────────────────────────────────────────────────

    {
      name: 'create_employee',
      description:
        'Add a new employee. Required: first_name, last_name, phone, email, password (≥8), branch_id, role_id. Recommended: service_ids (array of services they can perform). Optional: job_title, salary, commission_type ("none"/"fixed"/"percentage"), commission, start_date (YYYY-MM-DD). Phone digits only. Default password "12345678" is fine for testing if user doesn\'t provide one. CONFIRM all fields before calling — this creates a real user account with login credentials.',
      inputSchema: z.object({
        first_name: z.string().min(1),
        last_name: z.string().min(1),
        phone: z.string().min(7),
        email: z.string().email(),
        password: z.string().min(8).optional(),
        branch_id: z.union([z.number(), z.string()]),
        role_id: z.union([z.number(), z.string()]),
        service_ids: z.array(z.union([z.number(), z.string()])).optional(),
        job_title: z.string().optional(),
        salary: z.number().nonnegative().optional(),
        commission_type: z.enum(['none', 'fixed', 'percentage']).optional(),
        commission: z.number().nonnegative().optional(),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD.'),
      }),
      handler: async (input) => {
        const payload: Record<string, any> = { ...input };
        if (!payload.password) payload.password = '12345678';
        // Rename arrays to the keyed shape Laravel expects.
        if (input.service_ids) {
          delete payload.service_ids;
          payload.service_ids = input.service_ids;
        }
        return api.post('/employees', payload, { multipart: true });
      },
    },

    {
      name: 'activate_employee',
      description: 'Mark an employee active (can take bookings, appears in pickers). CONFIRM first.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
      }),
      handler: async ({ id }) => {
        return api.post(`/employees/${id}/activate`);
      },
    },

    {
      name: 'deactivate_employee',
      description:
        'Mark an employee inactive (hidden from booking pickers, kept in records). Use when an employee leaves or goes on extended leave. CONFIRM first.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
      }),
      handler: async ({ id }) => {
        return api.post(`/employees/${id}/deactivate`);
      },
    },

    // ── Offers ───────────────────────────────────────────────────

    {
      name: 'list_offers',
      description:
        'List promotional offers in the vendor\'s catalog. Each has name_ar, services, price_type ("service"/"free"/"discount"/"special"), offer_price, discount %, validity window, is_active. Use before create_offer to see existing ones.',
      inputSchema: z.object({
        branch_id: z.union([z.number(), z.string()]).optional(),
        per_page: z.number().int().min(1).max(100).optional(),
      }),
      handler: async (input) => {
        return api.getRaw('/offers', clean(input));
      },
    },

    {
      name: 'create_offer',
      description:
        'Create a promotional offer. Required: name_ar, description_ar, service_ids (array), branch_id (array), price_type. Price-type semantics: "service" = same price as service (no discount), "free" = 100% off, "discount" = set discount % and offer_price auto-computes from the first service, "special" = set offer_price and discount auto-computes. Optional: start_date / end_date (YYYY-MM-DD), featured. CONFIRM the pricing math with the user before calling.',
      inputSchema: z.object({
        name_ar: z.string().min(2),
        description_ar: z.string().min(2),
        service_ids: z.array(z.union([z.number(), z.string()])).min(1),
        branch_id: z.array(z.union([z.number(), z.string()])).min(1),
        price_type: z.enum(['service', 'free', 'discount', 'special']),
        discount: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe('Required for price_type="discount". Percentage 0-100.'),
        offer_price: z
          .number()
          .nonnegative()
          .optional()
          .describe('Required for price_type="special". The fixed promo price.'),
        service_price: z
          .number()
          .nonnegative()
          .optional()
          .describe('Anchor price used for the discount math. Defaults to the first service\'s price.'),
        start_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        end_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        featured: z.boolean().optional(),
      }),
      handler: async (input) => {
        // Compute the price/discount pair the backend expects based on
        // the price_type — mirrors the form logic in
        // mobile/src/api/endpoints/offers.ts.
        let offer_price = input.offer_price ?? 0;
        let discount = input.discount ?? 0;
        const basePrice = input.service_price ?? 0;
        switch (input.price_type) {
          case 'service':
            offer_price = basePrice;
            discount = 0;
            break;
          case 'free':
            offer_price = 0;
            discount = 100;
            break;
          case 'discount':
            offer_price = basePrice * ((100 - discount) / 100);
            break;
          case 'special':
            if (basePrice > 0) {
              discount = ((basePrice - offer_price) / basePrice) * 100;
            }
            break;
        }
        const payload: Record<string, any> = {
          name_ar: input.name_ar,
          name_en: 'dummy_name_en',
          description_ar: input.description_ar,
          description_en: 'dummy_descriptions_en',
          service_ids: input.service_ids,
          branch_id: input.branch_id,
          price_type: input.price_type,
          offer_price,
          discount,
          start_date: input.start_date,
          end_date: input.end_date,
          featured: input.featured ? '1' : '0',
        };
        return api.post('/offers', clean(payload), { multipart: true });
      },
    },

    // ── Branch + Calendar ────────────────────────────────────────

    {
      name: 'get_branch',
      description:
        'Get full detail for one branch including official_hours per weekday, gallery, manager, lat/long. Use when the user asks about working hours or before scheduling a booking to know the open window.',
      inputSchema: z.object({
        id: z.union([z.number(), z.string()]),
      }),
      handler: async ({ id }) => {
        return api.get(`/branches/${id}`);
      },
    },

    {
      name: 'get_calendar',
      description:
        'Day-view list of bookings for a specific date + branch. Returns the same shape as list_bookings but the backend already filters to one day server-side, so it\'s the right tool when the user says "اعرض جدول اليوم" or "wisht the calendar for tomorrow". `date` is YYYY-MM-DD. Optional employee_id filter narrows to one staff member.',
      inputSchema: z.object({
        branch_id: z.union([z.number(), z.string()]),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('YYYY-MM-DD.'),
        employee_id: z.union([z.number(), z.string()]).optional(),
      }),
      handler: async (input) => {
        // /calendar is POST (not GET) per the backend route file.
        return api.post('/calendar', clean(input), { multipart: true });
      },
    },
  ];
}
