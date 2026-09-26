/**
 * workers/sms.js
 * LinX — SMS Worker (Twilio inbound + outbound)
 *
 * Inbound flow:
 *   1. Validate Twilio HMAC-SHA1 signature (X-Twilio-Signature header)
 *   2. Parse From, Body, MessageSid
 *   3. Persist raw SMS to KV (7-day TTL)
 *   4. POST to ai-gateway /ai/classify for intent detection
 *   5. Store classified record in KV
 *   6. Run intent-based auto-reply logic
 *   7. Forward to CRM: POST /api/contacts with phone + intent
 *   8. Fire "sms.received" + "sms.intent.detected" events to event bus
 *   9. If intent === "opt_out" → mark KV, skip reply, stop pipeline
 *  10. Return empty TwiML 200 to Twilio immediately (all async via waitUntil)
 *
 * Auto-reply map (intent → message):
 *   inquiry    → "Thanks for reaching out! A LinX team member will contact you shortly."
 *   schedule   → "Got it — we'll reach out to book your appointment soon."
 *   complaint  → "We're sorry to hear that. A team member will follow up immediately."
 *   cancel     → "Understood. Your request has been noted. Reply STOP to opt out."
 *   unknown    → (no auto-reply)
 *   opt_out    → (no reply, mark opted-out)
 *
 * Routes:
 *   POST /sms/send        → outbound SMS via Twilio
 *   POST /sms/receive     → Twilio inbound webhook
 *   GET  /health          → worker health probe
 *   GET  /sms/log         → recent SMS log (?direction=inbound|outbound&from=&limit=20)
 *   GET  /sms/opt-outs    → list opted-out numbers
 *
 * Bindings (wrangler.jsonc):
 *   TWILIO_ACCOUNT_SID    secret
 *   TWILIO_AUTH_TOKEN     secret
 *   TWILIO_FROM_NUMBER    secret
 *   AI_GATEWAY_URL        secret  ← internal URL of ai-gateway worker
 *   API_URL               secret  ← internal URL of api.js worker
 *   API_INTERNAL_TOKEN    secret  ← service-to-service bearer token
 *   LINX_KV               KV namespace
 */

const JSON_HEADERS = { "Content-Type": "application/json" };
const TWILIO_API   = "https://api.twilio.com/2010-04-01";

// Auto-reply messages keyed by intent
const AUTO_REPLIES = {
  inquiry:   "Thanks for reaching out! A LinX team member will contact you shortly.",
  schedule:  "Got it — we'll reach out to confirm your appointment soon.",
  complaint: "We're sorry to hear that. A team member will follow up immediately.",
  cancel:    "Understood. Your request has been noted. Reply STOP to opt out.",
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") return corsOk();

    try {
      if (url.pathname === "/sms/send" && method === "POST") {
        return handleSend(request, env, ctx);
      }

      if (url.pathname === "/sms/receive" && method === "POST") {
        return handleReceive(request, env, ctx);
      }

      if (url.pathname === "/health" && method === "GET") {
        return ok({ ok: true, service: "linx-sms", ts: Date.now() });
      }

      if (url.pathname === "/sms/log" && method === "GET") {
        return handleLog(request, env);
      }

      if (url.pathname === "/sms/opt-outs" && method === "GET") {
        return handleOptOuts(env);
      }

      return err(404, "Not found");
    } catch (e) {
      return err(500, e.message ?? "Internal error");
    }
  },
};

// ---------------------------------------------------------------------------
// POST /sms/send — outbound SMS
// ---------------------------------------------------------------------------

async function handleSend(request, env, ctx) {
  // Service-to-service auth: the API worker and workflows authenticate with
  // API_INTERNAL_TOKEN. Without this check, anyone on the open internet could
  // send SMS through this worker and burn the Twilio balance. Fails open only
  // when the secret was never configured (to avoid breaking existing deploys).
  if (env.API_INTERNAL_TOKEN) {
    const authHeader = request.headers.get("Authorization") ?? "";
    if (authHeader !== `Bearer ${env.API_INTERNAL_TOKEN}`) {
      return err(403, "Forbidden");
    }
  }

  const body = await request.json();
  if (!body.to)   return err(400, "to is required");
  if (!body.body) return err(400, "body is required");

  // Honour opt-out — never send to an opted-out number
  const optedOut = await env.LINX_KV.get(`opt_out:${body.to}`);
  if (optedOut) return err(403, `${body.to} has opted out of SMS communications`);

  const form = new URLSearchParams({
    To:   body.to,
    From: env.TWILIO_FROM_NUMBER,
    Body: body.body,
  });

  const res  = await twilioFetch(env, `/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, form);
  const data = await res.json();

  if (!res.ok) return err(res.status, data?.message ?? "Twilio error");

  const record = {
    direction:      "outbound",
    to:             body.to,
    from:           env.TWILIO_FROM_NUMBER,
    body:           body.body,
    sid:            data.sid,
    status:         data.status,
    conversationId: body.conversationId ?? null,
    sentAt:         Date.now(),
  };

  ctx.waitUntil(
    env.LINX_KV.put(`sms:outbound:${data.sid}`, JSON.stringify(record), {
      expirationTtl: 604800,
    })
  );

  return ok({ sid: data.sid, status: data.status });
}

// ---------------------------------------------------------------------------
// POST /sms/receive — Twilio inbound webhook
// ---------------------------------------------------------------------------

async function handleReceive(request, env, ctx) {
  const raw    = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw));

  // Step 1 — Twilio HMAC-SHA1 signature validation
  if (env.TWILIO_AUTH_TOKEN) {
    const signatureHeader = request.headers.get("X-Twilio-Signature") ?? "";
    const isValid = await validateTwilioSignature(
      env.TWILIO_AUTH_TOKEN,
      request.url,
      params,
      signatureHeader
    );
    if (!isValid) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  const from = params.From       ?? "unknown";
  const body = params.Body       ?? "";
  const sid  = params.MessageSid ?? `sms-${Date.now()}`;
  const to   = params.To         ?? env.TWILIO_FROM_NUMBER;

  const inboundRecord = {
    direction:  "inbound",
    from,
    to,
    body,
    sid,
    raw:        params,
    receivedAt: Date.now(),
  };

  // Persist raw record immediately — always succeeds regardless of downstream
  ctx.waitUntil(
    env.LINX_KV.put(`sms:inbound:${sid}`, JSON.stringify(inboundRecord), {
      expirationTtl: 604800,
    })
  );

  // Kick off the full async pipeline
  ctx.waitUntil(processInbound(inboundRecord, env));

  // Return empty TwiML to Twilio immediately
  return twiml();
}

// ---------------------------------------------------------------------------
// Async inbound processing pipeline
// ---------------------------------------------------------------------------

async function processInbound(record, env) {
  // ── Step 1: Classify intent ──────────────────────────────────────────────
  let intent     = "unknown";
  let confidence = 0;
  let entities   = {};

  try {
    if (env.AI_GATEWAY_URL) {
      const classifyRes = await fetch(`${env.AI_GATEWAY_URL}/ai/classify`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
        },
        body:   JSON.stringify({ text: record.body }),
        signal: AbortSignal.timeout(10_000),
      });

      if (classifyRes.ok) {
        const classified = await classifyRes.json();
        intent     = classified.intent     ?? "unknown";
        confidence = classified.confidence ?? 0;
      }

      // Also extract entities for CRM enrichment
      const entityRes = await fetch(`${env.AI_GATEWAY_URL}/ai/agent`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
        },
        body:   JSON.stringify({ task: "extract_entities", payload: { text: record.body } }),
        signal: AbortSignal.timeout(10_000),
      });

      if (entityRes.ok) {
        const entityData = await entityRes.json();
        entities = entityData.entities ?? {};
      }
    }
  } catch {
    // Classification failure is non-fatal
  }

  // ── Step 2: Persist enriched classified record ───────────────────────────
  const enriched = { ...record, intent, confidence, entities, classifiedAt: Date.now() };
  await env.LINX_KV.put(`sms:classified:${record.sid}`, JSON.stringify(enriched), {
    expirationTtl: 604800,
  });

  // ── Step 3: Opt-out handling ─────────────────────────────────────────────
  if (intent === "opt_out" || /\bSTOP\b/i.test(record.body)) {
    await env.LINX_KV.put(`opt_out:${record.from}`, JSON.stringify({
      optedOutAt: Date.now(),
      trigger:    record.body,
    }), { expirationTtl: 0 }); // permanent — no TTL
    return;
  }

  // ── Step 4: Auto-reply based on intent ───────────────────────────────────
  const replyText = AUTO_REPLIES[intent];
  if (replyText && env.TWILIO_ACCOUNT_SID) {
    try {
      const replyForm = new URLSearchParams({
        To:   record.from,
        From: record.to,
        Body: replyText,
      });
      await twilioFetch(env, `/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, replyForm);
    } catch {
      // Auto-reply failure is non-fatal
    }
  }

  // ── Step 5: Forward to CRM ───────────────────────────────────────────────
  if (env.API_URL) {
    try {
      // Build contact payload from entities + fallback to phone
      const contactPayload = {
        phone:  entities.phone ?? record.from,
        name:   entities.name  ?? null,
        email:  entities.email ?? null,
        source: "sms",
        meta: {
          sms_sid:    record.sid,
          intent,
          confidence,
          first_message: record.body,
          received_at:   record.receivedAt,
        },
      };

      // email is required by api.js — use phone-derived placeholder if missing
      if (!contactPayload.email) {
        contactPayload.email = `sms-${record.from.replace(/\D/g, "")}@sms.linx.local`;
      }

      await fetch(`${env.API_URL}/api/contacts`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
        },
        body:   JSON.stringify(contactPayload),
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      // CRM forward failure is non-fatal
    }
  }

  // ── Step 6: Fire events to event bus ────────────────────────────────────
  if (env.API_URL) {
    const baseHeaders = {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
    };

    await Promise.allSettled([
      fetch(`${env.API_URL}/api/events`, {
        method:  "POST",
        headers: baseHeaders,
        body: JSON.stringify({
          type:    "sms.received",
          source:  "sms-worker",
          payload: { from: record.from, sid: record.sid, body: record.body, to: record.to },
        }),
      }),
      fetch(`${env.API_URL}/api/events`, {
        method:  "POST",
        headers: baseHeaders,
        body: JSON.stringify({
          type:    "sms.intent.detected",
          source:  "sms-worker",
          payload: { from: record.from, sid: record.sid, intent, confidence, entities },
        }),
      }),
    ]);
  }

  // ── Step 7: Escalation — fire workflow trigger for complaints ────────────
  if (intent === "complaint" && env.API_URL) {
    try {
      await fetch(`${env.API_URL}/api/automations/trigger`, {
        method:  "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
        },
        body: JSON.stringify({
          trigger: "sms.intent.detected",
          payload: { intent: "complaint", from: record.from, sid: record.sid, body: record.body },
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Escalation failure is non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// GET /sms/log
// ---------------------------------------------------------------------------

async function handleLog(request, env) {
  const url   = new URL(request.url);
  const dir   = url.searchParams.get("direction");
  const from  = url.searchParams.get("from");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20"), 100);

  const prefix = dir === "outbound" ? "sms:outbound:" : dir === "inbound" ? "sms:inbound:" : "sms:";
  const list   = await env.LINX_KV.list({ prefix, limit });

  const records = await Promise.all(
    list.keys.map(({ name }) => env.LINX_KV.get(name, { type: "json" }))
  );

  let results = records.filter(Boolean).reverse();
  if (from) results = results.filter((r) => r.from === from || r.to === from);

  return ok(results);
}

// ---------------------------------------------------------------------------
// GET /sms/opt-outs
// ---------------------------------------------------------------------------

async function handleOptOuts(env) {
  const list  = await env.LINX_KV.list({ prefix: "opt_out:", limit: 500 });
  const items = await Promise.all(
    list.keys.map(async ({ name }) => ({
      phone: name.replace("opt_out:", ""),
      ...(await env.LINX_KV.get(name, { type: "json" })),
    }))
  );
  return ok(items.filter(Boolean));
}

// ---------------------------------------------------------------------------
// Twilio HMAC-SHA1 signature validation
// Spec: https://www.twilio.com/docs/usage/webhooks/webhooks-security
// ---------------------------------------------------------------------------

async function validateTwilioSignature(authToken, url, params, signature) {
  // Build the validation string: URL + sorted params concatenated
  const sortedParams = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], "");

  const data    = url + sortedParams;
  const keyData = new TextEncoder().encode(authToken);
  const msgData = new TextEncoder().encode(data);

  const key = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );

  const sigBuffer = await crypto.subtle.sign("HMAC", key, msgData);
  const computed  = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

  return computed === signature;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function twilioFetch(env, path, form) {
  const credentials = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  return fetch(`${TWILIO_API}${path}`, {
    method:  "POST",
    headers: {
      Authorization:  `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
}

function twiml() {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
    { status: 200, headers: { "Content-Type": "text/xml" } }
  );
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
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
  });
}
