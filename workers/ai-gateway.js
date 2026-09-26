/**
 * workers/ai-gateway.js
 * LinX — AI Gateway Worker ("LinX Echo")
 *
 * Routes:
 *   POST /ai/chat              → full chat completion with conversation history
 *   POST /ai/classify          → intent classification for SMS/events
 *   POST /ai/agent             → dispatch a named agent task
 *   POST /ai/route             → multi-agent router — picks the right agent chain
 *   GET  /ai/history/:threadId → read conversation history
 *   DEL  /ai/history/:threadId → clear conversation history
 *   GET  /ai/memory/:ns/:key   → read namespaced KV memory
 *   PUT  /ai/memory/:ns/:key   → write namespaced KV memory
 *   DELETE /ai/memory/:ns/:key → delete namespaced KV memory
 *   GET  /ai/models            → list supported model aliases
 *   GET  /health               → liveness
 *
 * Bindings (wrangler.jsonc):
 *   AI                    Workers AI binding
 *   LINX_KV               KV namespace — memory, history, cache
 *   LINX_ECHO_URL         secret — external LinX Echo (FastAPI) base URL
 *   LINX_ECHO_SECRET      secret — shared bearer token for Echo
 *   API_URL               secret — internal api.js worker URL (for tool calls)
 *   API_INTERNAL_TOKEN    secret — service-to-service bearer token
 *
 * Tool calls allow agents to:
 *   - Create/update CRM contacts  → POST {API_URL}/api/contacts
 *   - Send SMS                    → POST {SMS_WORKER_URL}/sms/send
 *   - Fire automation trigger     → POST {API_URL}/api/automations/trigger
 *   - Write to event bus          → POST {API_URL}/api/events
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODELS = {
  chat:    "@cf/meta/llama-3.1-8b-instruct-fast",
  fast:    "@cf/meta/llama-3.1-8b-instruct-fast",
  summary: "@cf/meta/llama-3.1-8b-instruct-fast",
};

// Appended to every agent system prompt: some models emit Python-style
// single-quoted output unless explicitly told to use strict JSON.
const JSON_STRICT =
  " Use strict JSON only: double quotes for all keys and string values, " +
  "no single quotes, no markdown code fences, no commentary.";

// Parse a JSON object out of an AI text response. Tolerant of markdown
// fences, preamble/epilogue text, and single-quoted pseudo-JSON. Returns
// null when nothing parseable is found (callers fall back to defaults).
function parseAgentJson(raw) {
  // Workers AI parses JSON-looking model output into an object already —
  // use it directly instead of stringifying to "[object Object]".
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  const text = String(raw ?? "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const match = text.match(/\{[\s\S]*\}/); // greedy: first { to last }
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch { /* try lenient single-quote handling */ }
  try {
    const parsed = JSON.parse(match[0].replace(/'([^']*)'/g, '"$1"'));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* fall through */ }
  return null;
}

const INTENTS = ["schedule", "cancel", "inquiry", "complaint", "opt_out", "unknown"];

// Max messages kept in a conversation thread (sliding window)
const MAX_HISTORY_MESSAGES = 20;

// ---------------------------------------------------------------------------
// Agent task registry
// ---------------------------------------------------------------------------

const AGENT_TASKS = {
  // Existing
  summarize:          handleAgentSummarize,
  draft_reply:        handleAgentDraftReply,
  extract:            handleAgentExtract,
  // New
  qualify_lead:       handleAgentQualifyLead,
  schedule_followup:  handleAgentScheduleFollowup,
  generate_quote:     handleAgentGenerateQuote,
  sentiment:          handleAgentSentiment,
  extract_entities:   handleAgentExtractEntities,
  route_to_department:handleAgentRouteToDepartment,
};

// ---------------------------------------------------------------------------
// Multi-agent chain definitions
// Each chain = ordered list of agent tasks run in sequence.
// Output of each step is merged into the payload for the next.
// ---------------------------------------------------------------------------

const AGENT_CHAINS = {
  // SMS lead intake: classify intent → extract entities → qualify lead
  sms_intake: ["extract_entities", "qualify_lead", "route_to_department"],
  // Full CRM enrichment: sentiment + entity extraction
  crm_enrich: ["sentiment", "extract_entities"],
  // Support ticket: classify → sentiment → draft reply
  support:    ["sentiment", "draft_reply"],
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
      if (url.pathname === "/health" && method === "GET") {
        return ok({
          status:  "ok",
          mode:    env.LINX_ECHO_URL ? "proxy" : "workers-ai",
          agents:  Object.keys(AGENT_TASKS),
          chains:  Object.keys(AGENT_CHAINS),
          ts:      Date.now(),
        });
      }

      if (url.pathname === "/ai/models" && method === "GET") {
        return ok(Object.keys(MODELS).map((alias) => ({ alias, model: MODELS[alias] })));
      }

      if (url.pathname === "/ai/chat" && method === "POST") {
        return handleChat(request, env, ctx);
      }

      if (url.pathname === "/ai/classify" && method === "POST") {
        return handleClassify(request, env, ctx);
      }

      if (url.pathname === "/ai/agent" && method === "POST") {
        return handleAgentDispatch(request, env, ctx);
      }

      if (url.pathname === "/ai/route" && method === "POST") {
        return handleAgentRoute(request, env, ctx);
      }

      // Conversation history
      const histMatch = url.pathname.match(/^\/ai\/history\/([^/]+)$/);
      if (histMatch) {
        const threadId = histMatch[1];
        if (method === "GET")    return handleHistoryGet(threadId, env);
        if (method === "DELETE") return handleHistoryDelete(threadId, env);
      }

      // Namespaced memory: /ai/memory/:ns/:key
      const memMatch = url.pathname.match(/^\/ai\/memory\/([^/]+)\/([^/]+)$/);
      if (memMatch) {
        const [, ns, key] = memMatch;
        if (method === "GET")    return handleMemoryGet(ns, key, env);
        if (method === "PUT")    return handleMemoryPut(ns, key, request, env);
        if (method === "DELETE") return handleMemoryDelete(ns, key, env);
      }

      // Legacy flat memory path /ai/memory/:key (backward compat)
      const legacyMemMatch = url.pathname.match(/^\/ai\/memory\/([^/]+)$/);
      if (legacyMemMatch) {
        const key = legacyMemMatch[1];
        if (method === "GET")    return handleMemoryGet("global", key, env);
        if (method === "PUT")    return handleMemoryPut("global", key, request, env);
        if (method === "DELETE") return handleMemoryDelete("global", key, env);
      }

      return err(404, "Not found");
    } catch (e) {
      return err(500, e.message ?? "Internal error");
    }
  },
};

// ---------------------------------------------------------------------------
// POST /ai/chat
// Loads conversation history for threadId, appends user message,
// calls Echo/Workers AI, appends assistant response, saves updated history.
// ---------------------------------------------------------------------------

async function handleChat(request, env, ctx) {
  const body = await request.json();

  if (!body.messages || !Array.isArray(body.messages)) {
    return err(400, "messages[] is required");
  }

  const modelAlias = body.model ?? "chat";
  const model      = MODELS[modelAlias] ?? MODELS.chat;
  const threadId   = body.threadId ?? null;

  // --- Load + merge conversation history ---
  let messages = body.messages;
  if (threadId) {
    const history = await loadHistory(threadId, env);
    if (history.length > 0) {
      // Prepend history before the new user messages (keep system prompt at front)
      const systemMsgs = messages.filter((m) => m.role === "system");
      const userMsgs   = messages.filter((m) => m.role !== "system");
      messages = [...systemMsgs, ...history, ...userMsgs];
    }
  }

  // --- KV cache (skip for threaded convos — history makes each unique) ---
  const cacheKey = (!threadId && !body.noCache)
    ? `ai:chat:${await hashPrompt(messages)}`
    : null;

  if (cacheKey) {
    const cached = await env.LINX_KV.get(cacheKey, { type: "json" });
    if (cached) return ok({ ...cached, cached: true });
  }

  let result;

  if (env.LINX_ECHO_URL) {
    const echoRes = await fetch(`${env.LINX_ECHO_URL}/v1/chat`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${env.LINX_ECHO_SECRET ?? ""}`,
      },
      body: JSON.stringify({
        messages,
        userId:         body.userId         ?? null,
        teamId:         body.teamId         ?? null,
        conversationId: body.conversationId ?? threadId ?? null,
        meta:           body.meta           ?? {},
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!echoRes.ok) {
      const errBody = await echoRes.text().catch(() => "");
      return err(echoRes.status, `LinX Echo error (${echoRes.status}): ${errBody}`);
    }

    const echoData = await echoRes.json();
    result = {
      response:  echoData.content ?? echoData.response,
      model,
      tokensIn:  echoData.tokensIn  ?? 0,
      tokensOut: echoData.tokensOut ?? 0,
      messageId: echoData.messageId ?? null,
      threadId,
      source:    "linx-echo",
    };
  } else {
    if (!env.AI) {
      return err(503, "No AI binding configured. Add [ai] to wrangler.jsonc or set LINX_ECHO_URL.");
    }
    const aiRes = await env.AI.run(model, { messages });
    const aiText = aiRes?.response;
    result = {
      response:  typeof aiText === "string" ? aiText : JSON.stringify(aiText ?? aiRes ?? ""),
      model,
      tokensIn:  0,
      tokensOut: 0,
      messageId: null,
      threadId,
      source:    "workers-ai",
    };
  }

  // --- Persist history update + optional cache (async) ---
  ctx.waitUntil(
    (async () => {
      if (threadId && result.response) {
        // Append only the last user message + assistant reply to history
        const lastUser = body.messages.filter((m) => m.role === "user").at(-1);
        if (lastUser) {
          await appendHistory(threadId, [
            lastUser,
            { role: "assistant", content: result.response },
          ], env);
        }
      }
      if (cacheKey) {
        await env.LINX_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });
      }
    })()
  );

  return ok(result);
}

// ---------------------------------------------------------------------------
// POST /ai/classify
// ---------------------------------------------------------------------------

async function handleClassify(request, env, ctx) {
  const body = await request.json();
  if (!body.text) return err(400, "text is required");

  const cacheKey = `ai:classify:${await hashPrompt([body.text])}`;
  const cached   = await env.LINX_KV.get(cacheKey, { type: "json" });
  if (cached) return ok({ ...cached, cached: true });

  const systemPrompt =
    "You are a classification engine for a business SMS system. " +
    "Respond with ONLY a JSON object and nothing else: " +
    `{ "intent": "<intent>", "confidence": <0.0-1.0> }. ` +
    `Valid intents: ${INTENTS.join(", ")}.` + JSON_STRICT;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: body.text },
  ];

  let parsed;
  try {
    const raw = await callAI(messages, env, 15_000);
    parsed = parseAgentJson(raw) ?? { intent: "unknown", confidence: 0 };
    if (!INTENTS.includes(parsed.intent)) parsed = { intent: "unknown", confidence: 0 };
  } catch {
    parsed = { intent: "unknown", confidence: 0 };
  }

  const result = { input: body.text, intent: parsed.intent, confidence: parsed.confidence ?? 0 };
  ctx.waitUntil(env.LINX_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 }));
  return ok(result);
}

// ---------------------------------------------------------------------------
// POST /ai/agent  — single task dispatch
// Body: { task, payload, userId?, orgId? }
// ---------------------------------------------------------------------------

async function handleAgentDispatch(request, env, ctx) {
  const body = await request.json();
  if (!body.task) return err(400, "task is required");

  const handler = AGENT_TASKS[body.task];
  if (!handler) {
    return err(400, `Unknown task: "${body.task}". Known: ${Object.keys(AGENT_TASKS).join(", ")}`);
  }

  return handler(body.payload ?? {}, env, ctx, body);
}

// ---------------------------------------------------------------------------
// POST /ai/route  — multi-agent chain runner
// Body: { chain, payload, userId?, orgId? }
//   OR: { agents: ["task1","task2",...], payload, ... } for ad-hoc chains
// ---------------------------------------------------------------------------

async function handleAgentRoute(request, env, ctx) {
  const body = await request.json();

  let tasks;
  if (body.chain) {
    tasks = AGENT_CHAINS[body.chain];
    if (!tasks) {
      return err(400, `Unknown chain: "${body.chain}". Known: ${Object.keys(AGENT_CHAINS).join(", ")}`);
    }
  } else if (Array.isArray(body.agents) && body.agents.length > 0) {
    tasks = body.agents;
  } else {
    return err(400, "chain or agents[] is required");
  }

  // Validate all tasks exist before running any
  for (const task of tasks) {
    if (!AGENT_TASKS[task]) {
      return err(400, `Unknown agent task in chain: "${task}"`);
    }
  }

  // Run chain sequentially — each step's result is merged into the running payload
  let payload = body.payload ?? {};
  const steps = [];

  for (const task of tasks) {
    try {
      const res    = await AGENT_TASKS[task](payload, env, ctx, body);
      const result = await res.json();
      steps.push({ task, result });
      // Merge result fields into payload for next step
      if (result && typeof result === "object" && !result.error) {
        payload = { ...payload, ...result };
      }
    } catch (e) {
      steps.push({ task, error: e.message });
      // Chain continues — individual step failures are non-fatal
    }
  }

  return ok({ chain: body.chain ?? "custom", steps, finalPayload: payload });
}

// ---------------------------------------------------------------------------
// Conversation history — /ai/history/:threadId
// KV key: history:{threadId}
// Value: array of { role, content } (sliding window, max MAX_HISTORY_MESSAGES)
// ---------------------------------------------------------------------------

async function handleHistoryGet(threadId, env) {
  const history = await loadHistory(threadId, env);
  return ok({ threadId, messages: history, count: history.length });
}

async function handleHistoryDelete(threadId, env) {
  await env.LINX_KV.delete(`history:${threadId}`);
  return ok({ threadId, deleted: true });
}

async function loadHistory(threadId, env) {
  const raw = await env.LINX_KV.get(`history:${threadId}`, { type: "json" });
  return Array.isArray(raw) ? raw : [];
}

async function appendHistory(threadId, newMessages, env) {
  const existing = await loadHistory(threadId, env);
  const updated  = [...existing, ...newMessages].slice(-MAX_HISTORY_MESSAGES);
  await env.LINX_KV.put(`history:${threadId}`, JSON.stringify(updated), {
    expirationTtl: 86400 * 7, // 7 days
  });
}

// ---------------------------------------------------------------------------
// Namespaced memory — /ai/memory/:ns/:key
// KV key: mem:{ns}:{key}
// Namespaces: global | org:{orgId} | user:{userId} | thread:{threadId}
// ---------------------------------------------------------------------------

async function handleMemoryGet(ns, key, env) {
  const kvKey = `mem:${ns}:${key}`;
  const val   = await env.LINX_KV.get(kvKey, { type: "json" });
  if (val === null) return err(404, `Memory key not found: ${ns}/${key}`);
  return ok({ ns, key, value: val });
}

async function handleMemoryPut(ns, key, request, env) {
  const body = await request.json();
  if (body.value === undefined) return err(400, "value is required");

  const ttl   = typeof body.ttl === "number" ? body.ttl : 86400;
  const kvKey = `mem:${ns}:${key}`;

  await env.LINX_KV.put(kvKey, JSON.stringify(body.value), { expirationTtl: ttl });
  return ok({ ns, key, stored: true, ttl });
}

async function handleMemoryDelete(ns, key, env) {
  await env.LINX_KV.delete(`mem:${ns}:${key}`);
  return ok({ ns, key, deleted: true });
}

// ---------------------------------------------------------------------------
// Agent task implementations
// ---------------------------------------------------------------------------

// ── EXISTING ────────────────────────────────────────────────────────────────

async function handleAgentSummarize(payload, env) {
  if (!payload.text) return err(400, "payload.text is required for summarize");
  const messages = [
    { role: "system", content: "Summarize the following text in 2-3 sentences. Be concise and factual." },
    { role: "user",   content: payload.text },
  ];
  const response = await callAI(messages, env, 20_000);
  return ok({ task: "summarize", response });
}

async function handleAgentDraftReply(payload, env) {
  if (!payload.inbound_message) return err(400, "payload.inbound_message is required for draft_reply");
  const ctx = payload.contact_name ? `The customer's name is ${payload.contact_name}.` : "";
  const messages = [
    {
      role: "system",
      content:
        `You are a helpful business assistant. ${ctx} ` +
        "Draft a professional, concise SMS reply (under 160 characters). " +
        "Return ONLY the reply text, no explanation.",
    },
    { role: "user", content: payload.inbound_message },
  ];
  const response = await callAI(messages, env, 20_000);
  return ok({ task: "draft_reply", response });
}

async function handleAgentExtract(payload, env) {
  if (!payload.text) return err(400, "payload.text is required for extract");
  const fields = payload.fields ?? ["name", "phone", "email", "date", "issue"];
  const messages = [
    {
      role: "system",
      content:
        "Extract structured data from the text. " +
        `Return ONLY a JSON object with keys: ${fields.join(", ")}. ` +
        "Use null for any field not found." + JSON_STRICT,
    },
    { role: "user", content: payload.text },
  ];
  try {
    const raw       = await callAI(messages, env, 15_000);
    const extracted = parseAgentJson(raw) ?? {};
    return ok({ task: "extract", extracted });
  } catch {
    return err(500, "extract: AI call failed");
  }
}

// ── NEW ─────────────────────────────────────────────────────────────────────

async function handleAgentQualifyLead(payload, env, _ctx, meta) {
  const text = payload.text ?? payload.inbound_message ?? payload.body ?? "";
  if (!text) return err(400, "payload.text (or inbound_message/body) is required for qualify_lead");

  const messages = [
    {
      role: "system",
      content:
        "You are a CRM lead qualification engine for a contractor marketplace. " +
        "Analyse the message and return ONLY a JSON object: " +
        '{ "score": <1-10>, "tier": "hot"|"warm"|"cold", ' +
        '"needs": "<one-line summary>", "urgency": "immediate"|"this_week"|"planning", ' +
        '"budget_signal": "high"|"medium"|"low"|"unknown", "recommended_action": "<string>" }. ' +
        "Base score on intent clarity, urgency, and budget signals." + JSON_STRICT,
    },
    { role: "user", content: text },
  ];

  try {
    const raw  = await callAI(messages, env, 20_000);
    const lead = parseAgentJson(raw) ?? { score: 5, tier: "warm" };

    // Tool call: if API_URL is set, upsert lead score onto the contact record
    if (env.API_URL && meta?.contactId) {
      await toolCallAPI(env, "PATCH", `/api/contacts/${meta.contactId}`, {
        meta: { lead_score: lead.score, lead_tier: lead.tier, qualified_at: Date.now() },
      });
    }

    return ok({ task: "qualify_lead", ...lead });
  } catch {
    return err(500, "qualify_lead: AI call failed");
  }
}

async function handleAgentScheduleFollowup(payload, env, _ctx, meta) {
  const text = payload.text ?? payload.inbound_message ?? "";
  if (!text) return err(400, "payload.text is required for schedule_followup");

  const messages = [
    {
      role: "system",
      content:
        "You are a follow-up scheduling assistant. " +
        "Based on the message, return ONLY a JSON object: " +
        '{ "followup_in_hours": <number>, "followup_message": "<SMS text under 160 chars>", ' +
        '"reason": "<one-line reason>", "priority": "high"|"medium"|"low" }.' + JSON_STRICT,
    },
    { role: "user", content: text },
  ];

  try {
    const raw      = await callAI(messages, env, 15_000);
    const schedule = parseAgentJson(raw) ?? { followup_in_hours: 24, priority: "medium" };

    // Tool call: fire automation trigger for follow-up scheduling
    if (env.API_URL) {
      await toolCallAPI(env, "POST", "/api/automations/trigger", {
        trigger: "workflow.started",
        payload: {
          workflow:   "followup_sms",
          delayHours: schedule.followup_in_hours,
          message:    schedule.followup_message,
          to:         payload.from ?? meta?.from ?? null,
          priority:   schedule.priority,
        },
      });
    }

    return ok({ task: "schedule_followup", ...schedule });
  } catch {
    return err(500, "schedule_followup: AI call failed");
  }
}

async function handleAgentGenerateQuote(payload, env) {
  const project = payload.project_description ?? payload.text ?? "";
  if (!project) return err(400, "payload.project_description is required for generate_quote");

  const trade    = payload.trade    ?? "general contractor";
  const location = payload.location ?? "Canada";

  const messages = [
    {
      role: "system",
      content:
        `You are an expert ${trade} estimator in ${location}. ` +
        "Based on the project description, return ONLY a JSON object: " +
        '{ "estimate_low_cad": <number>, "estimate_high_cad": <number>, ' +
        '"timeline_days": <number>, "key_line_items": ["<item>", ...], ' +
        '"assumptions": ["<assumption>", ...], "disclaimer": "<string>" }. ' +
        "Use realistic Canadian labour and material rates." + JSON_STRICT,
    },
    { role: "user", content: project },
  ];

  try {
    const raw   = await callAI(messages, env, 25_000);
    const quote = parseAgentJson(raw) ?? {};
    return ok({ task: "generate_quote", ...quote });
  } catch {
    return err(500, "generate_quote: AI call failed");
  }
}

async function handleAgentSentiment(payload, env) {
  const text = payload.text ?? payload.inbound_message ?? payload.body ?? "";
  if (!text) return err(400, "payload.text is required for sentiment");

  const messages = [
    {
      role: "system",
      content:
        "Analyse the sentiment of the message. Return ONLY a JSON object: " +
        '{ "sentiment": "positive"|"neutral"|"negative", "score": <-1.0 to 1.0>, ' +
        '"emotion": "happy"|"frustrated"|"urgent"|"confused"|"satisfied"|"neutral", ' +
        '"escalate": <true|false> }. ' +
        "Set escalate=true if the message contains complaints, anger, or urgent distress." + JSON_STRICT,
    },
    { role: "user", content: text },
  ];

  try {
    const raw    = await callAI(messages, env, 10_000);
    const result = parseAgentJson(raw)
      ?? { sentiment: "neutral", score: 0, emotion: "neutral", escalate: false };
    return ok({ task: "sentiment", ...result });
  } catch {
    return err(500, "sentiment: AI call failed");
  }
}

async function handleAgentExtractEntities(payload, env) {
  const text = payload.text ?? payload.inbound_message ?? payload.body ?? "";
  if (!text) return err(400, "payload.text is required for extract_entities");

  const messages = [
    {
      role: "system",
      content:
        "Extract named entities from the message. Return ONLY a JSON object: " +
        '{ "name": <string|null>, "phone": <string|null>, "email": <string|null>, ' +
        '"address": <string|null>, "city": <string|null>, "province": <string|null>, ' +
        '"trade": <string|null>, "project_type": <string|null>, ' +
        '"dates": [<string>, ...], "amounts": [<string>, ...] }. ' +
        "Use null for fields not found. Normalize phone numbers to E.164 format if possible." + JSON_STRICT,
    },
    { role: "user", content: text },
  ];

  try {
    const raw      = await callAI(messages, env, 15_000);
    const entities = parseAgentJson(raw) ?? {};
    return ok({ task: "extract_entities", entities });
  } catch {
    return err(500, "extract_entities: AI call failed");
  }
}

async function handleAgentRouteToDepartment(payload, env) {
  const text   = payload.text ?? payload.inbound_message ?? payload.body ?? "";
  const intent = payload.intent ?? null;

  const messages = [
    {
      role: "system",
      content:
        "You are a routing engine for a contractor service platform. " +
        "Based on the message and optional intent, determine the correct department. " +
        "Return ONLY a JSON object: " +
        '{ "department": "sales"|"support"|"billing"|"scheduling"|"emergency"|"general", ' +
        '"reason": "<one-line>", "priority": "high"|"medium"|"low", ' +
        '"suggested_workflow": "<workflow_name>" }. ' +
        "emergency = any urgent safety/damage issue. " +
        "Suggested workflow names: qualify_lead, schedule_followup, support_ticket, billing_inquiry." + JSON_STRICT,
    },
    { role: "user", content: `Message: ${text}${intent ? `\nDetected intent: ${intent}` : ""}` },
  ];

  try {
    const raw     = await callAI(messages, env, 10_000);
    const routing = parseAgentJson(raw)
      ?? { department: "general", priority: "medium", suggested_workflow: "qualify_lead" };
    return ok({ task: "route_to_department", ...routing });
  } catch {
    return err(500, "route_to_department: AI call failed");
  }
}

// ---------------------------------------------------------------------------
// Tool call helper — lets agents call back into the API worker
// ---------------------------------------------------------------------------

async function toolCallAPI(env, method, path, body) {
  if (!env.API_URL) return null;
  try {
    return await fetch(`${env.API_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${env.API_INTERNAL_TOKEN ?? ""}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null; // tool call failures are non-fatal
  }
}

// ---------------------------------------------------------------------------
// Core AI call abstraction
// Handles Echo proxy + Workers AI fallback consistently across all agents.
// Returns the raw text response string.
// ---------------------------------------------------------------------------

async function callAI(messages, env, timeoutMs = 20_000) {
  if (env.LINX_ECHO_URL) {
    const res = await fetch(`${env.LINX_ECHO_URL}/v1/chat`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${env.LINX_ECHO_SECRET ?? ""}`,
      },
      body:   JSON.stringify({ messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Echo returned ${res.status}`);
    const data = await res.json();
    return data.content ?? data.response ?? "";
  }

  if (env.AI) {
    const aiRes = await env.AI.run(MODELS.chat, { messages });
    return aiRes?.response ?? "";
  }

  throw new Error("No AI binding configured. Add [ai] to wrangler.jsonc or set LINX_ECHO_URL.");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

async function hashPrompt(input) {
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  const buf     = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

async function runAgentAI(messages, env, taskName) {
  try {
    const response = await callAI(messages, env, 20_000);
    return ok({ task: taskName, response });
  } catch (e) {
    return err(502, `Agent task "${taskName}" failed: ${e.message}`);
  }
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
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
  });
}
