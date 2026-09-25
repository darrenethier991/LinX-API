/**
 * workers/api.js
 * LinX — Primary API Gateway Worker
 *
 * All requests pass through JWT auth middleware first.
 * Public (unauthenticated) routes are explicitly whitelisted (method-aware).
 *
 * Public routes:
 *   GET  /health                      → liveness + version
 *   POST /api/contacts                → public lead intake (rate-limited + validated)
 *   GET  /api/jobs                    → public job board feed (rate-limited, public-safe fields only)
 *
 *   ── CRM — contacts ──
 *   POST   /api/contacts              → upsert contact
 *   GET    /api/contacts              → list (?limit=50&offset=0&q=search)
 *   GET    /api/contacts/:id          → single contact
 *   PATCH  /api/contacts/:id          → partial update (tags, notes, lead_score, source)
 *
 *   ── CRM — orgs/teams ──
 *   POST   /api/orgs                  → create org
 *   GET    /api/orgs                  → list orgs
 *   GET    /api/orgs/:id              → single org
 *   PATCH  /api/orgs/:id              → update org
 *
 *   ── Automations ──
 *   POST   /api/automations/trigger   → fire a named trigger
 *   GET    /api/automations/triggers  → list registered triggers
 *
 *   ── Events (internal event bus) ──
 *   POST   /api/events                → enqueue event
 *   GET    /api/events                → list recent events (?type=&limit=20)
 *
 *   ── Usage ──
 *   GET    /api/usage                 → usage summary for auth'd user/org
 *
 * Bindings (wrangler.jsonc):
 *   SUPABASE_URL          secret
 *   SUPABASE_ANON_KEY     secret
 *   SUPABASE_SERVICE_KEY  secret  ← bypasses RLS for server-side ops
 *   LINX_KV               KV namespace
 */

const JSON_HEADERS = { "Content-Type": "application/json" };
const VERSION      = "1.3.1";

// Routes that skip JWT auth entirely (method-aware).
// POST /api/contacts is the public lead-intake endpoint used by the website
// contact form. Unauthenticated submissions are rate-limited per IP and pass
// strict validation inside handleCreateContact instead of JWT auth.
// GET /api/jobs is the public job board feed (public-safe fields only).
const PUBLIC_ROUTES = new Set([
  "GET /health",
  "POST /api/contacts",
  "GET /api/jobs",
]);

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") return corsOk();

    try {
      // ── Auth middleware ──────────────────────────────────────────────────
      if (!PUBLIC_ROUTES.has(`${method} ${url.pathname}`)) {
        const authError = await authenticate(request, env);
        if (authError) return authError;
      }

      // ── Route dispatch ───────────────────────────────────────────────────

      if (url.pathname === "/health" && method === "GET") {
        return ok({ status: "ok", version: VERSION, ts: Date.now() });
      }

      // CRM — contacts
      if (url.pathname === "/api/contacts") {
        if (method === "POST") return handleCreateContact(request, env, ctx);
        if (method === "GET")  return handleListContacts(request, env);
      }

      const contactMatch = url.pathname.match(/^\/api\/contacts\/([^/]+)$/);
      if (contactMatch) {
        const id = contactMatch[1];
        if (method === "GET")   return handleGetContact(id, env);
        if (method === "PATCH") return handleUpdateContact(id, request, env);
      }

      // Public job board feed (no auth; rate-limited; public-safe fields only)
      if (url.pathname === "/api/jobs" && method === "GET") {
        return handleListJobs(request, env);
      }

      // CRM — orgs
      if (url.pathname === "/api/orgs") {
        if (method === "POST") return handleCreateOrg(request, env);
        if (method === "GET")  return handleListOrgs(request, env);
      }

      const orgMatch = url.pathname.match(/^\/api\/orgs\/([^/]+)$/);
      if (orgMatch) {
        const id = orgMatch[1];
        if (method === "GET")   return handleGetOrg(id, env);
        if (method === "PATCH") return handleUpdateOrg(id, request, env);
      }

      // Automations
      if (url.pathname === "/api/automations/trigger" && method === "POST") {
        return handleFireTrigger(request, env, ctx);
      }
      if (url.pathname === "/api/automations/triggers" && method === "GET") {
        return handleListTriggers();
      }

      // Event bus
      if (url.pathname === "/api/events") {
        if (method === "POST") return handleEnqueueEvent(request, env, ctx);
        if (method === "GET")  return handleListEvents(request, env);
      }

      // Usage
      if (url.pathname === "/api/usage" && method === "GET") {
        return handleGetUsage(request, env);
      }

      return err(404, "Not found");
    } catch (e) {
      return err(500, e.message ?? "Internal error");
    }
  },

  // -------------------------------------------------------------------------
  // Cron handler — fires on "0 * * * *" (every hour, top of hour)
  // Scans LINX_KV for pending follow-up records written by
  // automations/workflows/schedule_followup.js and dispatches due ones
  // via the SMS worker.
  //
  // KV record shape (written by schedule_followup.js):
  //   key:     followup:{phone}:{timestamp}
  //   value:   { to, message, sendAt, status, contactId, priority, ... }
  // -------------------------------------------------------------------------
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledFollowups(env));
  },
};

// ---------------------------------------------------------------------------
// Scheduled follow-up dispatcher
// Separated from the handler so it can be unit-tested independently.
// ---------------------------------------------------------------------------

async function runScheduledFollowups(env) {
  if (!env.LINX_KV) return;

  const now    = Date.now();
  const list   = await env.LINX_KV.list({ prefix: "followup:", limit: 100 });
  let processed = 0;
  let skipped   = 0;
  let errors    = 0;

  for (const { name } of list.keys) {
    const record = await env.LINX_KV.get(name, { type: "json" });

    // Skip missing, already-sent, or not-yet-due records
    if (!record)                    { skipped++; continue; }
    if (record.status !== "pending") { skipped++; continue; }
    if (record.sendAt > now)         { skipped++; continue; }

    try {
      // Send via SMS worker (/sms/send), not the API worker itself
      const smsUrl = env.SMS_WORKER_URL ?? env.API_URL;
      const res = await fetch(`${smsUrl}/sms/send`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
        },
        body: JSON.stringify({
          to:             record.to,
          body:           record.message,
          conversationId: record.contactId ?? null,
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (res.ok) {
        const smsData = await res.json().catch(() => ({}));
        // Mark sent with 24h TTL (audit trail before expiry)
        await env.LINX_KV.put(name, JSON.stringify({
          ...record,
          status:  "sent",
          sentAt:  now,
          smsSid:  smsData.sid ?? null,
        }), { expirationTtl: 86400 });
        processed++;
      } else {
        // Mark failed — will be retried next cron run
        const retryCount = (record.retryCount ?? 0) + 1;
        await env.LINX_KV.put(name, JSON.stringify({
          ...record,
          status:     retryCount >= 3 ? "dead" : "failed",
          failedAt:   now,
          retryCount,
        }), { expirationTtl: retryCount >= 3 ? 3600 : 86400 });
        errors++;
      }
    } catch (e) {
      errors++;
    }
  }

  // Fire a summary event onto the bus for observability
  if (env.LINX_KV && (processed > 0 || errors > 0)) {
    const summaryKey = `event:workflow.cron.followup:${now}`;
    await env.LINX_KV.put(summaryKey, JSON.stringify({
      type:       "workflow.cron.followup",
      source:     "api.scheduled",
      payload:    { processed, skipped, errors, ranAt: now },
      enqueuedAt: now,
    }), { expirationTtl: 86400 });
  }
}

// ---------------------------------------------------------------------------
// Auth middleware
// Validates the Bearer JWT against Supabase /auth/v1/user.
// Result is cached in KV for 5 minutes to reduce Supabase calls.
// ---------------------------------------------------------------------------

async function authenticate(request, env) {
  const authHeader = request.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return err(401, "Missing Authorization header");
  }

  const token    = authHeader.slice(7);
  const cacheKey = `auth:${token.slice(0, 32)}`;
  const cached   = await env.LINX_KV.get(cacheKey, { type: "json" });

  if (cached) {
    request._user = cached;
    return null;
  }

  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey:        env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) return err(401, "Invalid or expired token");

  const user    = await res.json();
  request._user = {
    id:     user.id,
    email:  user.email,
    role:   user.role ?? "user",
    org_id: user.user_metadata?.org_id ?? null,
  };

  await env.LINX_KV.put(cacheKey, JSON.stringify(request._user), {
    expirationTtl: 300,
  });

  return null;
}

// ---------------------------------------------------------------------------
// CRM — contacts
// ---------------------------------------------------------------------------

async function handleCreateContact(request, env, ctx) {
  const isPublic = !request._user; // no JWT → came through the public lead-intake route

  let body;
  try {
    body = await request.json();
  } catch {
    return err(400, "Invalid JSON body");
  }
  if (!body || typeof body !== "object") return err(400, "Invalid JSON body");

  // ── Rate limit public submissions: 10/hour per IP (KV fixed window) ────────
  if (isPublic) {
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    const limited = await checkRateLimit(env, `contact-create:${ip}`, 10, 3600);
    if (limited) return err(429, "Too many requests — please try again later");
  }

  // ── Validation ─────────────────────────────────────────────────────────────
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!email) return err(400, "email is required");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return err(400, "email is invalid");
  }

  const str = (v, max) => {
    if (v == null) return null;
    const s = String(v).trim().slice(0, max);
    return s.length ? s : null;
  };

  const name  = str(body.name, 100);
  const phone = str(body.phone, 30);
  const notes = str(body.notes, 2000);

  const payload = {
    email,
    name,
    phone,
    org_id:     isPublic ? null : (body.org_id ?? request._user?.org_id ?? null),
    source:     isPublic ? "web" : (str(body.source, 50) ?? "api"),
    tags:       isPublic ? [] : (Array.isArray(body.tags) ? body.tags.map(String).slice(0, 20) : []),
    notes,
    lead_score: isPublic ? null : (Number.isFinite(body.lead_score) ? body.lead_score : null),
    meta:       body.meta && typeof body.meta === "object" ? body.meta : {},
    created_by: request._user?.id ?? null,
  };

  const res = await supabaseFetch(env, "POST", "/rest/v1/contacts", payload, true);
  if (!res.ok) return err(res.status, await res.text());

  const [contact] = await res.json();

  // ── Post-create side effects (never fail the request) ─────────────────────
  // 1. Enqueue crm.contact.created on the KV event bus so EVENT_ROUTING stays
  //    truthful for any current/future workflow consumers.
  // 2. Send the welcome SMS directly when we have a phone number. (There is
  //    currently no workflow runner consuming the event bus, so the
  //    send_welcome_sms workflow alone cannot fire.)
  try {
    await enqueueEvent(env, {
      type:    "crm.contact.created",
      source:  isPublic ? "web" : "api",
      payload: { contactId: contact?.id ?? null, email, phone },
    });

    const digits = (phone ?? "").replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      ctx.waitUntil(sendWelcomeSms(env, phone, contact?.id ?? null));
    }
  } catch {
    // Side effects must never break contact creation
  }

  return ok(contact, 201);
}

async function handleListContacts(request, env) {
  const url    = new URL(request.url);
  const limit  = Math.min(parseInt(url.searchParams.get("limit")  ?? "50"),  200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0"),   0);
  const search = url.searchParams.get("q");
  const tag    = url.searchParams.get("tag");
  const source = url.searchParams.get("source");

  let path = `/rest/v1/contacts?select=*&limit=${limit}&offset=${offset}&order=created_at.desc`;
  if (search) path += `&or=(email.ilike.*${encodeURIComponent(search)}*,name.ilike.*${encodeURIComponent(search)}*,phone.ilike.*${encodeURIComponent(search)}*)`;
  if (source) path += `&source=eq.${encodeURIComponent(source)}`;

  const res = await supabaseFetch(env, "GET", path);
  if (!res.ok) return err(res.status, await res.text());

  let contacts = await res.json();

  // Tag filter (client-side — Supabase PostgREST array contains filter)
  if (tag) contacts = contacts.filter((c) => Array.isArray(c.tags) && c.tags.includes(tag));

  return ok(contacts);
}

async function handleGetContact(id, env) {
  const res = await supabaseFetch(env, "GET", `/rest/v1/contacts?id=eq.${id}&select=*&limit=1`);
  if (!res.ok) return err(res.status, await res.text());

  const [contact] = await res.json();
  if (!contact) return err(404, "Contact not found");
  return ok(contact);
}

async function handleUpdateContact(id, request, env) {
  const body = await request.json();

  // Strip immutable fields
  delete body.id;
  delete body.created_at;
  delete body.created_by;

  // CRM enrichment fields explicitly allowed
  const allowedFields = [
    "name", "phone", "email", "org_id", "source",
    "tags", "notes", "lead_score", "meta", "updated_at",
  ];

  const patch = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) patch[field] = body[field];
  }

  // Deep-merge meta if provided
  if (body.meta) {
    const existing = await handleGetContact(id, env);
    if (existing.status === 200) {
      const current = await existing.json();
      patch.meta = { ...(current.meta ?? {}), ...body.meta };
    }
  }

  patch.updated_at = new Date().toISOString();

  const res = await supabaseFetch(env, "PATCH", `/rest/v1/contacts?id=eq.${id}`, patch, true);
  if (!res.ok) return err(res.status, await res.text());

  const [updated] = await res.json();
  return ok(updated);
}

// ---------------------------------------------------------------------------
// Public job board feed
// ---------------------------------------------------------------------------
// GET /api/jobs — public, rate-limited. Powers the job board on
// linxservices.ca/jobs.html (?type=project|hiring|seeking&trade=&city=&limit=&offset=).
//
// Job posts arrive as contacts through the public POST /api/contacts lead
// intake, with the job details stored in meta:
//   meta.post_type, meta.job_title, meta.job_category, meta.job_description,
//   meta.job_urgency, meta.job_city, meta.job_employment_type,
//   meta.job_availability, meta.job_budget_min, meta.job_budget_max
//
// PRIVACY: this endpoint must NEVER expose poster PII. The Supabase select
// below fetches only id, meta, tags, and created_at — name, email, phone,
// and notes are not even retrieved, so they cannot leak through the mapping.
// Moderation: PATCH the contact (auth'd) and add the "hidden" or "spam" tag
// to pull a post off the board without deleting the lead.
async function handleListJobs(request, env) {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (await checkRateLimit(env, `jobs-list:${ip}`, 120, 3600)) {
    return err(429, "Too many requests — please try again later");
  }

  const url    = new URL(request.url);
  const limit  = Math.min(parseInt(url.searchParams.get("limit")  ?? "50"), 100);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0"),   0);
  const type   = url.searchParams.get("type"); // project | hiring | seeking
  const trade  = url.searchParams.get("trade");
  const city   = url.searchParams.get("city");

  // PostgREST JSON operators on the meta column. Posts created before the
  // hiring update have no meta.post_type and are treated as projects.
  const typeFilter = type === "hiring"
    ? "meta->>post_type=eq.hiring"
    : type === "seeking"
      ? "meta->>post_type=eq.seeking"
      : type === "project"
        ? "or=(meta->>post_type.eq.project,meta->>post_type.is.null)"
        : "or=(meta->>post_type.in.(project,hiring,seeking),meta->>post_type.is.null)";

  let path = `/rest/v1/contacts?select=id,meta,tags,created_at&source=eq.web&${typeFilter}&order=created_at.desc&limit=${limit}&offset=${offset}`;
  if (trade) path += `&meta->>job_category=eq.${encodeURIComponent(trade)}`;
  if (city)  path += `&meta->>job_city=eq.${encodeURIComponent(city)}`;

  const res = await supabaseFetch(env, "GET", path, null, true);
  if (!res.ok) return err(res.status, await res.text());

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v) => {
    const s = String(v ?? "").trim();
    return s ? s : null;
  };

  const jobs = (await res.json())
    .filter((c) => !((c.tags ?? []).some((t) => t === "hidden" || t === "spam")))
    .map((c) => {
      const meta = c.meta ?? {};
      return {
        id:              c.id,
        post_type:       meta.post_type === "hiring" ? "hiring"
                        : meta.post_type === "seeking" ? "seeking" : "project",
        title:           str(meta.job_title) ?? "(untitled)",
        trade:           str(meta.job_category) ?? "General",
        city:            str(meta.job_city) ?? "Simcoe County",
        budget_min:      num(meta.job_budget_min),
        budget_max:      num(meta.job_budget_max),
        employment_type: str(meta.job_employment_type),
        availability:    str(meta.job_availability),
        urgency:         str(meta.job_urgency),
        description:     str(meta.job_description) ?? "",
        posted_at:       c.created_at,
      };
    });

  return ok(jobs);
}

// ---------------------------------------------------------------------------
// CRM — orgs
// ---------------------------------------------------------------------------

async function handleCreateOrg(request, env) {
  const body = await request.json();
  if (!body.name) return err(400, "name is required");

  const payload = {
    name:         body.name,
    billing_type: body.billing_type ?? "payg",
    owner_user_id: request._user?.id ?? null,
    meta:         body.meta ?? {},
  };

  const res = await supabaseFetch(env, "POST", "/rest/v1/teams", payload, true);
  if (!res.ok) return err(res.status, await res.text());

  const [org] = await res.json();
  return ok(org, 201);
}

async function handleListOrgs(request, env) {
  const url    = new URL(request.url);
  const limit  = Math.min(parseInt(url.searchParams.get("limit")  ?? "50"), 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0"),  0);

  const res = await supabaseFetch(
    env, "GET",
    `/rest/v1/teams?select=*&limit=${limit}&offset=${offset}&order=created_at.desc`
  );
  if (!res.ok) return err(res.status, await res.text());
  return ok(await res.json());
}

async function handleGetOrg(id, env) {
  const res = await supabaseFetch(env, "GET", `/rest/v1/teams?id=eq.${id}&select=*&limit=1`);
  if (!res.ok) return err(res.status, await res.text());

  const [org] = await res.json();
  if (!org) return err(404, "Org not found");
  return ok(org);
}

async function handleUpdateOrg(id, request, env) {
  const body = await request.json();
  delete body.id;
  delete body.created_at;
  delete body.owner_user_id;
  body.updated_at = new Date().toISOString();

  const res = await supabaseFetch(env, "PATCH", `/rest/v1/teams?id=eq.${id}`, body, true);
  if (!res.ok) return err(res.status, await res.text());

  const [updated] = await res.json();
  return ok(updated);
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

// Event routing map — which workflows fire on which event types
const EVENT_ROUTING = {
  "sms.received":          ["qualify_lead"],
  "sms.intent.detected":   ["qualify_lead", "schedule_followup"],
  "crm.contact.created":   ["send_welcome_sms"],
  "crm.contact.updated":   [],
  "workflow.started":      [],
  "workflow.completed":    [],
};

const TRIGGER_REGISTRY = {
  "contact.created":     { description: "Fires when a new CRM contact is created" },
  "contact.updated":     { description: "Fires when a CRM contact is updated" },
  "sms.received":        { description: "Fires when an inbound SMS arrives" },
  "sms.intent.detected": { description: "Fires after AI classifies an inbound SMS" },
  "workflow.started":    { description: "Fires when a workflow begins" },
  "workflow.completed":  { description: "Fires when a workflow completes" },
};

async function handleFireTrigger(request, env, ctx) {
  const body = await request.json();
  if (!body.trigger) return err(400, "trigger name is required");

  if (!TRIGGER_REGISTRY[body.trigger]) {
    return err(400, `Unknown trigger: "${body.trigger}". GET /api/automations/triggers to list valid names.`);
  }

  const event = {
    type:     body.trigger,
    payload:  body.payload  ?? {},
    orgId:    body.orgId    ?? request._user?.org_id ?? null,
    userId:   body.userId   ?? request._user?.id     ?? null,
    firedBy:  request._user?.id ?? "system",
    firedAt:  Date.now(),
    workflows: EVENT_ROUTING[body.trigger] ?? [],
  };

  const key = `trigger:${body.trigger}:${Date.now()}`;
  ctx.waitUntil(
    env.LINX_KV.put(key, JSON.stringify(event), { expirationTtl: 86400 })
  );

  return ok({ fired: true, trigger: body.trigger, key, workflows: event.workflows });
}

function handleListTriggers() {
  const triggers = Object.entries(TRIGGER_REGISTRY).map(([name, meta]) => ({
    name,
    ...meta,
    routes_to: EVENT_ROUTING[name] ?? [],
  }));
  return ok(triggers);
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

async function handleEnqueueEvent(request, env, ctx) {
  const body = await request.json();
  if (!body.type) return err(400, "event.type is required");

  const event = {
    type:       body.type,
    payload:    body.payload   ?? {},
    source:     body.source    ?? "api",
    orgId:      body.orgId     ?? request._user?.org_id ?? null,
    userId:     request._user?.id ?? null,
    enqueuedAt: Date.now(),
    // Attach routing metadata
    routes_to:  EVENT_ROUTING[body.type] ?? [],
  };

  const key = `event:${body.type}:${Date.now()}`;
  ctx.waitUntil(
    env.LINX_KV.put(key, JSON.stringify(event), { expirationTtl: 86400 })
  );

  return ok({ queued: true, key, routes_to: event.routes_to });
}

async function handleListEvents(request, env) {
  const url   = new URL(request.url);
  const type  = url.searchParams.get("type");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20"), 100);

  const prefix = type ? `event:${type}:` : "event:";
  const list   = await env.LINX_KV.list({ prefix, limit });

  const events = await Promise.all(
    list.keys.map(({ name }) => env.LINX_KV.get(name, { type: "json" }))
  );

  return ok(events.filter(Boolean).reverse());
}

// ---------------------------------------------------------------------------
// Usage endpoint
// Reads from Supabase usage_stats for the authenticated user / their org.
// ---------------------------------------------------------------------------

async function handleGetUsage(request, env) {
  const url       = new URL(request.url);
  const userId    = request._user?.id;
  const orgId     = request._user?.org_id ?? url.searchParams.get("org_id");
  const startDate = url.searchParams.get("start") ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const endDate   = url.searchParams.get("end")   ?? new Date().toISOString().slice(0, 10);

  const results = {};

  // User-scoped usage
  if (userId) {
    const userRes = await supabaseFetch(
      env, "GET",
      `/rest/v1/usage_stats?scope_type=eq.user&scope_id=eq.${userId}&date=gte.${startDate}&date=lte.${endDate}&select=*&order=date.desc`
    );
    if (userRes.ok) results.user = await userRes.json();
  }

  // Org-scoped usage
  if (orgId) {
    const orgRes = await supabaseFetch(
      env, "GET",
      `/rest/v1/usage_stats?scope_type=eq.team&scope_id=eq.${orgId}&date=gte.${startDate}&date=lte.${endDate}&select=*&order=date.desc`
    );
    if (orgRes.ok) results.org = await orgRes.json();
  }

  // Aggregate totals from user data
  const userRows = results.user ?? [];
  const totals = userRows.reduce((acc, row) => ({
    messages: acc.messages + (row.messages_count ?? 0),
    tokensIn:  acc.tokensIn  + (row.tokens_in     ?? 0),
    tokensOut: acc.tokensOut + (row.tokens_out    ?? 0),
  }), { messages: 0, tokensIn: 0, tokensOut: 0 });

  return ok({
    period: { start: startDate, end: endDate },
    totals,
    daily:  userRows,
    org:    results.org ?? [],
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fixed-window rate limiter backed by KV. Returns true when the caller is
// over the limit. Fails open (returns false) when KV is unavailable.
async function checkRateLimit(env, key, limit, windowSec) {
  if (!env.LINX_KV) return false;
  try {
    const kvKey = `ratelimit:${key}`;
    const now   = Date.now();
    const rec   = await env.LINX_KV.get(kvKey, { type: "json" });

    if (!rec || now > rec.resetAt) {
      await env.LINX_KV.put(
        kvKey,
        JSON.stringify({ count: 1, resetAt: now + windowSec * 1000 }),
        { expirationTtl: windowSec + 60 }
      );
      return false;
    }
    if (rec.count >= limit) return true;

    await env.LINX_KV.put(
      kvKey,
      JSON.stringify({ count: rec.count + 1, resetAt: rec.resetAt }),
      { expirationTtl: windowSec + 60 }
    );
    return false;
  } catch {
    return false;
  }
}

// Write an event onto the KV event bus (same shape as handleEnqueueEvent).
async function enqueueEvent(env, { type, source, payload }) {
  if (!env.LINX_KV || !type) return;
  const event = {
    type,
    payload:    payload ?? {},
    source:     source  ?? "api",
    enqueuedAt: Date.now(),
    routes_to:  EVENT_ROUTING[type] ?? [],
  };
  await env.LINX_KV.put(
    `event:${type}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    JSON.stringify(event),
    { expirationTtl: 86400 }
  );
}

const WELCOME_SMS =
  "Hi! Thanks for reaching out to LinX — Canada's Contractor Network. " +
  "We'll be in touch shortly. Reply STOP to opt out.";

// Send the welcome SMS via the SMS worker. The sms worker honours opt-outs
// itself; failures are swallowed so contact creation never breaks.
async function sendWelcomeSms(env, phone, contactId) {
  try {
    const smsUrl = env.SMS_WORKER_URL ?? env.API_URL;
    if (!smsUrl) return;
    await fetch(`${smsUrl}/sms/send`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
      },
      body: JSON.stringify({
        to:             phone,
        body:           WELCOME_SMS,
        conversationId: contactId,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Swallowed — SMS failure must not affect the API response
  }
}

function supabaseFetch(env, method, path, body, useServiceKey = false) {
  const key = useServiceKey
    ? (env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_ANON_KEY)
    : env.SUPABASE_ANON_KEY;

  return fetch(`${env.SUPABASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey:          key,
      Authorization:  `Bearer ${key}`,
      Prefer:          "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function ok(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, "Access-Control-Allow-Origin": "*" },
  });
}

function err(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...JSON_HEADERS, "Access-Control-Allow-Origin": "*" },
  });
}

function corsOk() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
  });
}
