# LinX — Production Deployment Runbook
# Follow these steps IN ORDER. Each step depends on the previous.

---

## Prerequisites

- [ ] Cloudflare account with Workers Paid plan (or Free — all features used are free-tier)
- [ ] Supabase project created (free tier is fine)
- [ ] Twilio account with a purchased phone number
- [ ] Domain `linxservices.ca` added to Cloudflare (DNS + proxied)
- [ ] Node.js 18+ installed locally
- [ ] Wrangler CLI installed: `npm install -g wrangler`
- [ ] Logged in: `wrangler login`

---

## Step 1 — Supabase: Run Migrations

Open Supabase Studio → SQL Editor. Run in this exact order:

```
supabase/migrations/0001_billing_schema.sql   ← wallets, teams, users, enterprise_config, transactions, usage_stats, rate_limit_events, RPCs
supabase/migrations/0002_rls_policies.sql     ← RLS + helper functions (is_admin, my_team_id)
supabase/migrations/0003_indexes.sql          ← performance indexes
supabase/migrations/0004_usage_rpc.sql        ← increment_usage_stat RPC
supabase/migrations/0005_contacts_schema.sql  ← contacts table, upsert_contact RPC
```

After running, verify in Table Editor:
- `users`, `teams`, `wallets`, `transactions`, `usage_stats`, `enterprise_config`, `rate_limit_events`, `contacts` all exist
- RLS is enabled on all tables (lock icon visible in Table Editor)

Copy from Supabase dashboard → Settings → API:
- `Project URL` → `SUPABASE_URL`
- `anon public` key → `SUPABASE_ANON_KEY`
- `service_role` key → `SUPABASE_SERVICE_KEY` ⚠️ never expose

---

## Step 2 — KV Namespace

```bash
# Create the shared KV namespace (used by all three workers)
wrangler kv namespace create LINX_KV

# Output example:
# { binding = "LINX_KV", id = "abc123..." }

# Also create a preview namespace for local dev
wrangler kv namespace create LINX_KV --preview
```

Edit `wrangler.jsonc`: replace all four `REPLACE_WITH_KV_*` placeholders with the real IDs.

---

## Step 3 — Generate Internal Token

```bash
# On Linux/Mac:
openssl rand -hex 32

# On Windows PowerShell:
[System.Web.Security.Membership]::GeneratePassword(64, 0)
# or:
-join ((65..90) + (97..122) + (48..57) | Get-Random -Count 64 | % {[char]$_})
```

Save the output as `API_INTERNAL_TOKEN` — you'll need it in Step 4.

---

## Step 4 — Deploy Workers + Set Secrets

Deploy in this order (ai-gateway first, then sms, then api — so URLs exist before referencing them).

### 4a. Deploy linx-ai-gateway

```bash
wrangler deploy --env ai

# Set secrets for ai worker:
wrangler secret put LINX_ECHO_URL          --env ai
wrangler secret put LINX_ECHO_SECRET       --env ai
wrangler secret put API_URL                --env ai   # https://api.linxservices.ca
wrangler secret put API_INTERNAL_TOKEN     --env ai
```

Note the deployed URL (e.g. `https://ai.linxservices.ca` or `https://linx-ai-gateway.your-subdomain.workers.dev`).

### 4b. Deploy linx-sms

```bash
wrangler deploy --env sms

# Set secrets for sms worker:
wrangler secret put TWILIO_ACCOUNT_SID     --env sms
wrangler secret put TWILIO_AUTH_TOKEN      --env sms
wrangler secret put TWILIO_FROM_NUMBER     --env sms
wrangler secret put AI_GATEWAY_URL         --env sms   # from step 4a
wrangler secret put API_URL                --env sms   # https://api.linxservices.ca
wrangler secret put API_INTERNAL_TOKEN     --env sms
```

Note the deployed URL. Configure in Twilio dashboard:
- Phone Number → Messaging → Webhook URL → `https://sms.linxservices.ca/sms/receive`
- HTTP Method → POST

### 4c. Deploy linx-api (default)

```bash
wrangler deploy

# Set secrets for api worker:
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put AI_GATEWAY_URL         # from step 4a
wrangler secret put SMS_WORKER_URL         # from step 4b
wrangler secret put API_INTERNAL_TOKEN
wrangler secret put LINX_ECHO_URL
wrangler secret put LINX_ECHO_SECRET
```

---

## Step 5 — DNS (Cloudflare)

Add CNAME records in Cloudflare DNS (Workers Routes are set in `wrangler.jsonc`):

| Type  | Name  | Target                          | Proxy |
|-------|-------|---------------------------------|-------|
| CNAME | api   | linx-api.your-account.workers.dev   | ✅ |
| CNAME | sms   | linx-sms.your-account.workers.dev   | ✅ |
| CNAME | ai    | linx-ai-gateway.your-account.workers.dev | ✅ |

Or use Workers Routes (already in `wrangler.jsonc` `"routes"` array — wrangler sets these automatically on deploy if `zone_name` matches).

---

## Step 6 — Verify

```bash
# Health checks
curl https://api.linxservices.ca/health
# → { "status": "ok", "version": "1.1.0", "ts": ... }

curl https://ai.linxservices.ca/health
# → { "status": "ok", "mode": "proxy"|"workers-ai", "agents": [...], ... }

# SMS worker
curl https://sms.linxservices.ca/sms/opt-outs
# → []

# List triggers
curl -H "Authorization: Bearer YOUR_SUPABASE_JWT" \
  https://api.linxservices.ca/api/automations/triggers
# → [{ name, description, routes_to }, ...]
```

---

## Step 7 — Cron Trigger (Follow-up SMS dispatcher)

The `schedule_followup` workflow stores pending SMS in KV. The cron trigger fires every hour to dispatch due follow-ups.

The api.js worker needs a `scheduled` export to handle this. Add to `workers/api.js`:

```js
export default {
  async fetch(request, env, ctx) { /* existing */ },

  async scheduled(event, env, ctx) {
    const { runCron } = await import('../automations/workflows/schedule_followup.js');
    ctx.waitUntil(runCron(env));
  },
};
```

The cron `"0 * * * *"` is already in `wrangler.jsonc` — it activates automatically on next deploy.

---

## Step 8 — Local Development

```bash
# Install dependencies
npm install

# Copy env
cp .env.example .env
# Fill in .env with real values

# Run api worker locally
npm run dev

# Run sms worker locally
npm run dev:sms

# Run ai-gateway locally
npm run dev:ai
```

For local dev without Supabase: the auth middleware can be bypassed by adding `/health` and other
test routes to the `PUBLIC_ROUTES` set in `api.js`.

---

## Secret Rotation

To rotate `API_INTERNAL_TOKEN`:
1. Generate new token
2. `wrangler secret put API_INTERNAL_TOKEN` on all three workers
3. Update workflows if they use the token directly (they read from `env.API_INTERNAL_TOKEN`)

---

## Monitoring

All Workers have built-in observability in the Cloudflare dashboard:
- Workers → linx-api → Logs (real-time)
- Workers → linx-api → Analytics (requests, errors, CPU time)
- KV → LINX_KV → Browse (inspect event bus, opt-outs, history)
