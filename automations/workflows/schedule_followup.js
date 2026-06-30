/**
 * automations/workflows/schedule_followup.js
 * LinX Workflow — Schedule Follow-up SMS
 *
 * Triggered by:
 *   event:   sms.intent.detected  (intent = "schedule")
 *   trigger: workflow.started     (workflow = "schedule_followup")
 *   Direct:  qualify_lead workflow fires this for hot leads (score >= 8)
 *
 * What it does:
 *   1. Calls ai-gateway /ai/agent → schedule_followup to compute delay + message
 *   2. Stores a pending follow-up record in KV with a future send timestamp
 *   3. Updates the contact meta with follow-up info
 *   4. Fires workflow.completed event
 *
 * Note on execution:
 *   This workflow stores the follow-up in KV. A Cloudflare Cron Trigger
 *   (defined in wrangler.jsonc) polls KV for due follow-ups and dispatches them.
 *   See wrangler.jsonc [triggers] → crons → "0 * * * *" (every hour).
 *
 * Payload shape:
 *   {
 *     contactId?:  "uuid",
 *     from:        "+1xxxxxxxxxx",
 *     body:        "raw inbound message",
 *     intent?:     "schedule",
 *     priority?:   "high" | "medium" | "low",
 *   }
 */

export async function run(payload, env) {
  const result = {
    workflow:  "schedule_followup",
    startedAt: Date.now(),
    steps:     [],
    success:   false,
  };

  const text = payload.body ?? payload.text ?? "";
  if (!text) {
    result.steps.push({ step: "skipped", reason: "No message body" });
    result.success    = true;
    result.finishedAt = Date.now();
    return result;
  }

  // ── Step 1: Compute follow-up schedule via AI agent ──────────────────────
  let schedule = { followup_in_hours: 24, followup_message: null, priority: payload.priority ?? "medium" };

  try {
    const agentRes = await callAIGateway(env, "POST", "/ai/agent", {
      task: "schedule_followup",
      payload: {
        text:  text,
        from:  payload.from ?? null,
        intent: payload.intent ?? "schedule",
      },
    });

    if (agentRes?.ok) {
      const agentData = await agentRes.json();
      schedule = {
        followup_in_hours: agentData.followup_in_hours ?? 24,
        followup_message:  agentData.followup_message  ?? null,
        priority:          agentData.priority          ?? "medium",
        reason:            agentData.reason            ?? null,
      };
      result.steps.push({ step: "ai_schedule", ...schedule });
    } else {
      result.steps.push({ step: "ai_schedule", fallback: true });
    }
  } catch (e) {
    result.steps.push({ step: "ai_schedule", error: e.message, fallback: true });
  }

  // ── Step 2: Build follow-up record ───────────────────────────────────────
  const sendAt     = Date.now() + schedule.followup_in_hours * 3_600_000;
  const followupId = `followup:${payload.from?.replace(/\D/g, "") ?? "unknown"}:${Date.now()}`;

  const followupRecord = {
    id:          followupId,
    to:          payload.from,
    message:     schedule.followup_message ?? buildDefaultMessage(payload.from),
    priority:    schedule.priority,
    reason:      schedule.reason ?? null,
    contactId:   payload.contactId ?? null,
    sendAt,
    scheduledAt: Date.now(),
    status:      "pending",
    source:      "workflow.schedule_followup",
  };

  // ── Step 3: Persist to KV ─────────────────────────────────────────────────
  if (env.LINX_KV) {
    try {
      await env.LINX_KV.put(followupId, JSON.stringify(followupRecord), {
        expirationTtl: 7 * 86400, // 7 days max
      });
      result.steps.push({ step: "kv_store", followupId, sendAt: new Date(sendAt).toISOString() });
    } catch (e) {
      result.steps.push({ step: "kv_store", error: e.message });
    }
  }

  // ── Step 4: Update contact meta ───────────────────────────────────────────
  if (payload.contactId && env.API_URL) {
    try {
      await callAPI(env, "PATCH", `/api/contacts/${payload.contactId}`, {
        meta: {
          followup_scheduled_at: Date.now(),
          followup_send_at:      sendAt,
          followup_id:           followupId,
          followup_priority:     schedule.priority,
        },
      });
      result.steps.push({ step: "contact_meta_updated", contactId: payload.contactId });
    } catch (e) {
      result.steps.push({ step: "contact_meta_updated", error: e.message });
    }
  }

  // ── Step 5: Fire workflow.completed event ─────────────────────────────────
  try {
    await callAPI(env, "POST", "/api/events", {
      type:    "workflow.completed",
      source:  "workflow.schedule_followup",
      payload: { workflow: "schedule_followup", followupId, sendAt, contactId: payload.contactId ?? null },
    });
    result.steps.push({ step: "event_fired", type: "workflow.completed" });
  } catch {
    // Non-fatal
  }

  result.success    = !result.steps.some((s) => s.error && !s.fallback);
  result.finishedAt = Date.now();
  result.durationMs = result.finishedAt - result.startedAt;

  return result;
}

// ---------------------------------------------------------------------------
// Cron handler — called by the Cloudflare Cron Trigger every hour.
// Scans KV for pending follow-ups whose sendAt <= now() and dispatches them.
// ---------------------------------------------------------------------------

export async function runCron(env) {
  if (!env.LINX_KV) return { processed: 0, errors: 0 };

  const list     = await env.LINX_KV.list({ prefix: "followup:", limit: 100 });
  const now      = Date.now();
  let processed  = 0;
  let errors     = 0;

  for (const { name } of list.keys) {
    const record = await env.LINX_KV.get(name, { type: "json" });
    if (!record || record.status !== "pending") continue;
    if (record.sendAt > now) continue;

    // Due — send the SMS
    try {
      const smsRes = await callSMS(env, "POST", "/sms/send", {
        to:   record.to,
        body: record.message,
        conversationId: record.contactId ?? null,
      });

      if (smsRes?.ok) {
        const smsData = await smsRes.json();
        // Mark as sent
        await env.LINX_KV.put(name, JSON.stringify({
          ...record,
          status:  "sent",
          sentAt:  now,
          smsSid:  smsData.sid,
        }), { expirationTtl: 86400 }); // keep for 24h then expire
        processed++;
      } else {
        // Mark as failed — will retry next cron
        await env.LINX_KV.put(name, JSON.stringify({
          ...record,
          status:     "failed",
          failedAt:   now,
          retryCount: (record.retryCount ?? 0) + 1,
        }), { expirationTtl: 86400 });
        errors++;
      }
    } catch (e) {
      errors++;
    }
  }

  return { processed, errors, checkedAt: now };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDefaultMessage(phone) {
  return "Hi! Just following up from LinX. Let us know if you're still looking for a contractor — we're ready to help.";
}

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
