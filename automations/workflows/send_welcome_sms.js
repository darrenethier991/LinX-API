/**
 * automations/workflows/send_welcome_sms.js
 * LinX Workflow — Send Welcome SMS
 *
 * Triggered by:
 *   event: crm.contact.created  (when source = "sms" or "web")
 *
 * What it does:
 *   1. Looks up the contact to get their name and phone
 *   2. Calls ai-gateway /ai/agent → draft_reply to personalise the message
 *   3. Checks opt-out status (skips if opted out)
 *   4. Sends welcome SMS via sms.js /sms/send
 *   5. Fires workflow.completed event
 *
 * Payload shape:
 *   {
 *     contactId: "uuid",
 *     orgId?:    "uuid",
 *   }
 */

const DEFAULT_WELCOME =
  "Hi! Thanks for reaching out to LinX — Canada's Contractor Network. " +
  "We'll be in touch shortly. Reply STOP to opt out.";

export async function run(payload, env) {
  const result = {
    workflow:  "send_welcome_sms",
    startedAt: Date.now(),
    steps:     [],
    success:   false,
  };

  // ── Step 1: Load contact ──────────────────────────────────────────────────
  let contact = null;
  try {
    const res = await callAPI(env, "GET", `/api/contacts/${payload.contactId}`);
    if (res?.ok) {
      contact = await res.json();
      result.steps.push({ step: "load_contact", email: contact.email, phone: contact.phone });
    } else {
      result.steps.push({ step: "load_contact", error: "Not found" });
      result.finishedAt = Date.now();
      return result;
    }
  } catch (e) {
    result.steps.push({ step: "load_contact", error: e.message });
    result.finishedAt = Date.now();
    return result;
  }

  if (!contact.phone) {
    result.steps.push({ step: "skipped", reason: "No phone number on contact" });
    result.success   = true; // not an error — contact just has no phone
    result.finishedAt = Date.now();
    return result;
  }

  // ── Step 2: Check opt-out ─────────────────────────────────────────────────
  if (env.LINX_KV) {
    const optedOut = await env.LINX_KV.get(`opt_out:${contact.phone}`);
    if (optedOut) {
      result.steps.push({ step: "skipped", reason: "Phone is opted out" });
      result.success   = true;
      result.finishedAt = Date.now();
      return result;
    }
  }

  // ── Step 3: Draft personalised welcome message ────────────────────────────
  let message = DEFAULT_WELCOME;
  try {
    if (env.AI_GATEWAY_URL && contact.meta?.first_message) {
      const agentRes = await callAIGateway(env, "POST", "/ai/agent", {
        task: "draft_reply",
        payload: {
          inbound_message: contact.meta.first_message,
          contact_name:    contact.name ?? null,
        },
      });

      if (agentRes?.ok) {
        const agentData = await agentRes.json();
        if (agentData.response && agentData.response.trim().length > 0) {
          message = agentData.response.trim();
        }
      }
    }
    result.steps.push({ step: "draft_message", message });
  } catch (e) {
    // Draft failure is non-fatal — fall back to default message
    result.steps.push({ step: "draft_message", fallback: true, error: e.message });
  }

  // ── Step 4: Send SMS ──────────────────────────────────────────────────────
  try {
    const smsRes = await callSMS(env, "POST", "/sms/send", {
      to:             contact.phone,
      body:           message,
      conversationId: payload.contactId,
    });

    if (smsRes?.ok) {
      const smsData = await smsRes.json();
      result.steps.push({ step: "sms_sent", sid: smsData.sid, status: smsData.status });
    } else {
      const errText = await smsRes?.text().catch(() => "");
      result.steps.push({ step: "sms_sent", error: `HTTP ${smsRes?.status}: ${errText}` });
    }
  } catch (e) {
    result.steps.push({ step: "sms_sent", error: e.message });
  }

  // ── Step 5: Fire workflow.completed event ─────────────────────────────────
  try {
    await callAPI(env, "POST", "/api/events", {
      type:    "workflow.completed",
      source:  "workflow.send_welcome_sms",
      payload: { workflow: "send_welcome_sms", contactId: payload.contactId },
    });
    result.steps.push({ step: "event_fired", type: "workflow.completed" });
  } catch {
    // Non-fatal
  }

  result.success    = result.steps.every((s) => !s.error);
  result.finishedAt = Date.now();
  result.durationMs = result.finishedAt - result.startedAt;

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callAPI(env, method, path, body) {
  if (!env.API_URL) return Promise.resolve({ ok: false, status: 503 });
  return fetch(`${env.API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
    },
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
}

function callAIGateway(env, method, path, body) {
  if (!env.AI_GATEWAY_URL) return Promise.resolve({ ok: false, status: 503 });
  return fetch(`${env.AI_GATEWAY_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
    },
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
}

function callSMS(env, method, path, body) {
  if (!env.SMS_WORKER_URL) return Promise.resolve({ ok: false, status: 503 });
  return fetch(`${env.SMS_WORKER_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
    },
    body:   body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
}
