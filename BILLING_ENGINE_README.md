# LinX Billing Engine — Implementation Guide for Lovable

## What's in this repository

This codebase contains the **complete, implementation-ready** LinX Billing Engine. All files
listed below are authored and ready to run. Lovable's only task is to:

1. Install dependencies
2. Create the Supabase project and run migrations
3. Fill in `.env` values
4. Deploy via TanStack Start

---

## Step 1 — Install dependencies

```bash
npm install @tanstack/start @tanstack/react-router @supabase/supabase-js zod stripe vite-tsconfig-paths
```

---

## Step 2 — Create Supabase project

1. Go to [supabase.com](https://supabase.com) → New Project
2. Copy your project URL, anon key, and service role key
3. Copy `.env.example` → `.env` and fill in all values:
   ```
   SUPABASE_URL=...
   SUPABASE_ANON_KEY=...
   SUPABASE_SERVICE_ROLE_KEY=...
   VITE_SUPABASE_URL=...         (same as SUPABASE_URL)
   VITE_SUPABASE_ANON_KEY=...    (same as SUPABASE_ANON_KEY)
   LINX_ECHO_URL=...
   LINX_ECHO_SECRET=...
   ```

---

## Step 3 — Run migrations in order

In Supabase Studio → SQL Editor, run each file in order:

```
supabase/migrations/0001_billing_schema.sql   ← tables + RPCs + auth trigger
supabase/migrations/0002_rls_policies.sql     ← RLS policies
supabase/migrations/0003_indexes.sql          ← performance indexes
supabase/migrations/0004_usage_rpc.sql        ← increment_usage_stat RPC
```

Or use the Supabase CLI:
```bash
npx supabase db push
```

---

## Step 4 — Regenerate TypeScript types (optional)

After migrations run:
```bash
npx supabase gen types typescript --local > src/lib/supabase/types.ts
```

---

## Step 5 — Start the dev server

```bash
npm run dev
```

---

## Architecture reference

```
Browser / React UI
  │
  │ Server function calls (createServerFn)
  ▼
src/server/
  ├── auth.ts       → requireAuth(), requireAdmin()
  ├── billing.ts    → getWallet, purchaseCredits, adminAdjustWallet
  ├── messaging.ts  → sendMessage (9-step orchestration)
  ├── usage.ts      → getMyUsage, getTeamUsage
  └── admin.ts      → getAdminTeams, getAdminTeamDetails, updateTeamLimits,
                       throttleTeam, suspendTeam, reactivateTeam, getAdminAlerts

src/lib/
  ├── agents/
  │   ├── BillingAgent.ts     → wallet resolution, atomic deduction, credits
  │   ├── UsageAgent.ts       → usage_stats upserts and queries
  │   ├── RateLimitAgent.ts   → per-user delay, per-minute, global daily cap
  │   ├── EnterpriseAgent.ts  → enterprise soft/hard caps, status management
  │   ├── AdminAgent.ts       → admin views, adjustments, config
  │   ├── errors.ts           → BillingError, error codes, user messages
  │   └── index.ts            → barrel export
  ├── echoClient.ts           → LinX Echo HTTP client (POST /v1/chat)
  ├── env.ts                  → typed env accessor (throws on missing vars)
  └── supabase/
      ├── client.ts           → browser Supabase (anon key, respects RLS)
      ├── server.ts           → server Supabase (service role, bypasses RLS)
      └── types.ts            → TypeScript database types

src/pages/
  ├── BillingAdmin.tsx        → team wallets, transactions, wallet adjustments
  └── UsageAdmin.tsx          → alerts, throttled/suspended teams, global cap

src/components/UI/
  └── BillingErrorBanner.tsx  → structured error display with admin hints
```

---

## sendMessage flow (the critical path)

```
1. requireAuth()                           → userId, teamId, billingType
2. BillingAgent.resolveWallet()            → wallet (PAYG only)
   EnterpriseAgent.getConfig()            → config (enterprise only)
3. RateLimitAgent.checkGlobalDailyCap()   → throws GLOBAL_CAP_REACHED
   RateLimitAgent.checkPerUserRateLimit() → throws RATE_LIMIT (3s delay)
   RateLimitAgent.checkPerUserMinuteLimit()→ throws RATE_LIMIT (>20/min)
4. EnterpriseAgent.checkEnterpriseStatus()→ throws TEAM_SUSPENDED
   EnterpriseAgent.checkDailyCaps()       → throws HARD_CAP or sets softCapWarning
   EnterpriseAgent.checkMonthlyCaps()     → same
   EnterpriseAgent.checkBurstLimit()      → throws RATE_LIMIT
5. BillingAgent.checkBalance()            → throws INSUFFICIENT_FUNDS (PAYG)
6. echoClient.sendMessage()               → throws AI_GATEWAY_ERROR on failure
7. UsageAgent.incrementUsage()            → upserts usage_stats (fire-and-forget)
   RateLimitAgent.recordEvent()           → inserts rate_limit_event (fire-and-forget)
8. BillingAgent.deductBalance()           → atomic FOR UPDATE deduction (PAYG)
9. return { response, usage, balanceCents?, softCapWarning? }
```

---

## Error codes

| Code | Trigger | User sees |
|---|---|---|
| `INSUFFICIENT_FUNDS` | PAYG balance < cost | "You've run out of credits." |
| `RATE_LIMIT` | Too fast / too many per minute | "Slow down." |
| `ENTERPRISE_SOFT_CAP` | Daily/monthly soft cap hit | "Near limit — warning only, message sent." |
| `ENTERPRISE_HARD_CAP` | Daily/monthly hard cap hit | "Limit reached — message blocked." |
| `GLOBAL_CAP_REACHED` | Platform-wide daily cap | "High demand — try later." |
| `TEAM_SUSPENDED` | enterprise_config.status = suspended | "Account suspended." |
| `AI_GATEWAY_ERROR` | LinX Echo non-200 / timeout | "AI unavailable." |

---

## Admin dashboard pages

| Page (Sidebar) | Component | Powers |
|---|---|---|
| Wallet & Credits | `BillingAdmin.tsx` | Team list, wallet balances, transactions, manual adjustments |
| Usage & Alerts | `UsageAdmin.tsx` | Alert panel, throttled/suspended teams, global cap %, reactivate/suspend actions |

---

## LinX Echo contract

`sendMessage` sends:
```json
POST /v1/chat
Authorization: Bearer <LINX_ECHO_SECRET>

{
  "messages":       [{ "role": "user", "content": "..." }],
  "userId":         "uuid",
  "teamId":         "uuid | null",
  "conversationId": "uuid (optional)",
  "meta":           { "billingType": "payg" }
}
```

Expected response:
```json
{
  "content":   "AI response text",
  "tokensIn":  42,
  "tokensOut": 150,
  "messageId": "uuid"
}
```

If `tokensIn`/`tokensOut` are missing, they default to `0` — usage logging never blocks.

---

## Security checklist

- [x] `SUPABASE_SERVICE_ROLE_KEY` only referenced in `src/lib/supabase/server.ts`
- [x] `LINX_ECHO_SECRET` only referenced in `src/lib/echoClient.ts`
- [x] All server-only env vars use `process.env.*` (never `import.meta.env`)
- [x] Browser env vars use `VITE_` prefix (anon key + URL only)
- [x] RLS enabled on all 7 tables
- [x] `is_admin()` and `my_team_id()` helpers use `security definer`
- [x] No client-side writes to wallets, transactions, or usage_stats
- [x] `deduct_wallet_balance()` uses `FOR UPDATE` row lock
- [x] All server functions call `requireAuth()` or `requireAdmin()` first
- [x] `assertTeamAccess()` guards all cross-team data access
