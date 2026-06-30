/**
 * automations/workflows/qualify_lead.js
 * LinX Workflow — Qualify Lead
 *
 * Triggered by:
 *   event: sms.received       (from sms.js → api.js event bus)
 *   event: sms.intent.detected
 *   trigger: contact.created  (when source = "sms")
 *
 * What it does:
 *   1. Calls ai-gateway /ai/route with chain "sms_intake"
 *      → extract_entities → qualify_lead → route_to_department
 *   2. PATCHes the contact record with lead_score, lead_tier, department
 *   3. Fires crm.contact.updated event
 *   4. If score >= 8 (hot lead) → fires schedule_followup workflow
 *
 * Usage (called from api.js event routing or manually):
 *   import { run } from './qualify_lead.js';
 *   await run(payload, env);
 *
 * Payload shape:
 *   {
 *     from:       "+1xxxxxxxxxx",   // phone number
 *     body:       "...",            // raw message text
 *     sid:        "SMxxx",          // Twilio SID
 *     contactId:  "uuid",           // optional — looked up by phone if missing
 *   }
 */

export async function run(payload, env) {
  const result = {
    workflow:  "qualify_lead",
    startedAt: Date.now(),
    steps:     [],
    success:   false,
  };

  // ── Step 1: Run sms_intake agent chain ────────────────────────────────────
  try {
    const chainRes = await callAIGateway(env, "POST", "/ai/route", {
      chain:   "sms_intake",
      payload: {
        text:   payload.body ?? "",
        from:   payload.from ?? null,
        intent: payload.intent ?? null,
      },
    });

    if (!chainRes.ok) {
      result.steps.push({ step: "ai_chain", error: `HTTP ${chainRes.status}` });
    } else {
      const chainData = await chainRes.json();
      result.steps.push({ step: "ai_chain", result: chainData });

      const final = chainData.finalPayload ?? {};
      const score = final.score ?? null;
      const tier  = final.tier  ?? null;
      const dept  = final.department ?? null;

      // ── Step 2: Update contact record ──────────────────────────────────
      const contactId = payload.contactId ?? await lookupContactIdByPhone(payload.from, env);
      if (contactId) {
        const patchRes = await callAPI(env, "PATCH", `/api/contacts/${contactId}`, {
          lead_score: score,
          meta: {
            lead_tier:          tier,
            routed_department:  dept,
            qualified_at:       Date.now(),
            qualify_workflow:   "qualify_lead",
            suggested_workflow: final.suggested_workflow ?? null,
          },
        });
        result.steps.push({
          step:      "contact_patch",
          contactId,
          score,
          tier,
          dept,
          ok: patchRes?.ok ?? false,
        });

        // ── Step 3: Fire crm.contact.updated event ────────────────────
        await callAPI(env, "POST", "/api/events", {
          type:    "crm.contact.updated",
          source:  "workflow.qualify_lead",
          payload: { contactId, score, tier, dept },
        });
        result.steps.push({ step: "event_fired", type: "crm.contact.updated" });

        // ── Step 4: Hot lead → trigger schedule_followup ──────────────
        if (score >= 8) {
          await callAPI(env, "POST", "/api/automations/trigger", {
            trigger: "workflow.started",
            payload: {
              workflow:  "schedule_followup",
              contactId,
              from:      payload.from,
              body:      payload.body,
              intent:    payload.intent,
              priority:  "high",
            },
          });
          result.steps.push({ step: "trigger_followup", contactId, score });
        }
      } else {
        result.steps.push({ step: "contact_patch", error: "Contact not found by phone" });
      }
    }
  } catch (e) {
    result.steps.push({ step: "error", message: e.message });
  }

  result.success   = result.steps.every((s) => !s.error);
  result.finishedAt = Date.now();
  result.durationMs = result.finishedAt - result.startedAt;

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function lookupContactIdByPhone(phone, env) {
  if (!phone || !env.API_URL) return null;
  try {
    const res = await callAPI(env, "GET", `/api/contacts?q=${encodeURIComponent(phone)}&limit=1`);
    if (!res?.ok) return null;
    const contacts = await res.json();
    return contacts[0]?.id ?? null;
  } catch {
    return null;
  }
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
    signal: AbortSignal.timeout(25_000),
  });
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
