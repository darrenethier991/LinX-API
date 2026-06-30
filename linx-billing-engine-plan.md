# LinX Billing + Multi-Agent System — Architecture Plan

## Context

The existing `linx-site` codebase is a **Vite + React 19 admin dashboard** with zero backend
integration — all data is mock-only. This plan is a **greenfield architecture specification**
for Lovable to implement the full billing engine and multi-agent system from scratch.

The spec targets:
- **TanStack Start** (SSR + server functions via `createServerFn`)
- **Vite** (bundler)
- **React 19** (UI)
- **Supabase** (Postgres + Auth + RLS)
- **TypeScript** (strict mode)
- **LinX Echo** (Cloudflare Worker — AI inference gateway)

The existing mock UI components (`Card`, `Table`, `Badge`, `StatCard`) are reusable and should
be preserved. The new system wraps them with live data from Supabase server functions.

---

## Top-Level Overview

The LinX Billing Engine is a pay-as-you-go + enterprise billing system that:

1. Tracks every AI message sent through LinX Echo
2. Deducts credits from wallets (PAYG) or enforces cap/rate limits (Enterprise)
3. Exposes server functions consumed by the admin dashboard and end-user UI
4. Uses five internal TypeScript agent modules (BillingAgent, UsageAgent, RateLimitAgent,
   EnterpriseAgent, AdminAgent) that are called sequentially inside `sendMessage`
5. Treats LinX Echo as an external HTTP service — all billing decisions happen in Supabase
   before the AI call is made

---

## Sub-Tasks

---

### Sub-Task 1 — Supabase Project Bootstrap

**Status:** [ ] pending

**Intent:**
Initialize the Supabase project, configure environment variables, and install the Supabase
client SDK into TanStack Start. This is the foundation all other sub-tasks depend on.

**Expected Outcomes:**
- `@supabase/supabase-js` installed
- `src/lib/supabase/client.ts` — browser client (used by React components)
- `src/lib/supabase/server.ts` — server-side client (used inside `createServerFn`, reads
  `process.env.SUPABASE_SERVICE_ROLE_KEY` — bypasses RLS for admin operations)
- `src/lib/supabase/types.ts` — generated TypeScript types from the schema
- `.env` with `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
  `LINX_ECHO_URL`, `LINX_ECHO_SECRET`, `COST_PER_MESSAGE_CENTS`
- TanStack Start `app.config.ts` configured with Vite + React plugin

**Todo List:**
1. Run `npm install @supabase/supabase-js @tanstack/start @tanstack/router`
2. Create `app.config.ts` at project root for TanStack Start
3. Create `src/lib/supabase/client.ts` using `createBrowserClient`
4. Create `src/lib/supabase/server.ts` using `createClient` with service role key
5. Add `.env` with all required keys (never commit service role key)
6. Add `src/lib/supabase/types.ts` placeholder (populated after migrations run)

**Relevant Context:**
- Supabase server client must use the **service role key** inside server functions to perform
  writes and admin reads that bypass RLS
- Browser client uses the **anon key** and respects RLS
- `COST_PER_MESSAGE_CENTS` defaults to `1` (1 cent per message); stored in env so it can be
  changed without a deploy
- `LINX_ECHO_SECRET` is a shared secret sent as `Authorization: Bearer <secret>` header to
  LinX Echo

---

### Sub-Task 2 — Database Schema + Migrations

**Status:** [ ] pending

**Intent:**
Define all Supabase tables, foreign keys, indexes, and RLS policies via SQL migration files.
This is the single source of truth for the data model.

**Expected Outcomes:**
- Migration file `supabase/migrations/0001_billing_schema.sql` that creates all tables
- Migration file `supabase/migrations/0002_rls_policies.sql` that applies all RLS policies
- Migration file `supabase/migrations/0003_indexes.sql` for performance indexes
- All tables visible in Supabase Studio with correct relationships

**Todo List:**

#### Table Definitions (migration 0001)

**`users`**
```sql
create table public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null default 'user' check (role in ('user', 'admin')),
  team_id     uuid references public.teams(id) on delete set null,
  plan        text not null default 'free' check (plan in ('free','starter','pro','enterprise')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
```
Note: `id` mirrors `auth.users.id` — no separate sequence. A Supabase trigger populates this
row on `auth.users` insert.

**`teams`**
```sql
create table public.teams (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  owner_user_id         uuid not null references public.users(id),
  billing_type          text not null default 'payg' check (billing_type in ('payg','enterprise')),
  wallet_id             uuid references public.wallets(id) on delete set null,
  enterprise_config_id  uuid references public.enterprise_config(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
```

**`wallets`**
```sql
create table public.wallets (
  id                    uuid primary key default gen_random_uuid(),
  owner_type            text not null check (owner_type in ('user','team')),
  owner_id              uuid not null,
  balance_cents         bigint not null default 0 check (balance_cents >= 0),
  currency              text not null default 'USD',
  daily_soft_limit_cents bigint,
  daily_hard_limit_cents bigint,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
```

**`transactions`**
```sql
create table public.transactions (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references public.wallets(id),
  type          text not null check (type in ('credit_purchase','message_debit','admin_adjustment')),
  amount_cents  bigint not null,
  message_id    uuid,
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
```
Note: `amount_cents` is positive for credits, negative for debits.

**`usage_stats`**
```sql
create table public.usage_stats (
  id              uuid primary key default gen_random_uuid(),
  scope_type      text not null check (scope_type in ('user','team','global')),
  scope_id        text not null,
  date            date not null,
  messages_count  integer not null default 0,
  tokens_in       integer not null default 0,
  tokens_out      integer not null default 0,
  last_message_at timestamptz,
  unique (scope_type, scope_id, date)
);
```
Note: `scope_id` is `user_id` (uuid as text), `team_id` (uuid as text), or the literal string
`'global'` when `scope_type = 'global'`.

**`enterprise_config`**
```sql
create table public.enterprise_config (
  id                            uuid primary key default gen_random_uuid(),
  team_id                       uuid not null unique references public.teams(id),
  daily_soft_cap_messages       integer not null default 1000,
  daily_hard_cap_messages       integer not null default 2000,
  monthly_soft_cap_messages     integer not null default 20000,
  monthly_hard_cap_messages     integer not null default 40000,
  rate_limit_per_user_per_minute integer not null default 20,
  burst_limit_per_user          integer not null default 5,
  status                        text not null default 'active'
                                  check (status in ('active','throttled','suspended')),
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now()
);
```

#### Auth Trigger (append to migration 0001)
```sql
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.users (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
```

#### RLS Policies (migration 0002)

Enable RLS on every table:
```sql
alter table public.users            enable row level security;
alter table public.teams            enable row level security;
alter table public.wallets          enable row level security;
alter table public.transactions     enable row level security;
alter table public.usage_stats      enable row level security;
alter table public.enterprise_config enable row level security;
```

**`users` policies:**
- `users_select_own` — `auth.uid() = id`
- `users_select_admin` — `exists (select 1 from public.users where id = auth.uid() and role = 'admin')`
- `users_update_own` — `auth.uid() = id` (cannot change own role)

**`teams` policies:**
- `teams_select_member` — `id in (select team_id from public.users where id = auth.uid())`
- `teams_select_admin` — admin full access
- `teams_insert_owner` — `owner_user_id = auth.uid()`
- `teams_update_owner` — `owner_user_id = auth.uid()` or admin

**`wallets` policies:**
- `wallets_select_own_user` — `owner_type = 'user' and owner_id = auth.uid()`
- `wallets_select_own_team` — `owner_type = 'team' and owner_id in (select team_id from public.users where id = auth.uid())`
- `wallets_select_admin` — admin full access
- No direct insert/update from client — wallets are modified only via server functions (service role)

**`transactions` policies:**
- `transactions_select_own` — `wallet_id in (wallets the user can see)`
- `transactions_select_admin` — admin full access
- No insert/update from client — server only

**`usage_stats` policies:**
- `usage_select_own_user` — `scope_type = 'user' and scope_id = auth.uid()::text`
- `usage_select_own_team` — `scope_type = 'team' and scope_id in (user's team_id as text)`
- `usage_select_global_admin` — admin can see `scope_type = 'global'`
- No insert/update from client

**`enterprise_config` policies:**
- `ec_select_member` — `team_id in (user's team)`
- `ec_select_admin` — admin full access
- `ec_update_admin` — admin only

#### Indexes (migration 0003)
```sql
create index idx_users_team_id            on public.users(team_id);
create index idx_transactions_wallet_id   on public.transactions(wallet_id);
create index idx_transactions_created_at  on public.transactions(created_at desc);
create index idx_usage_stats_scope        on public.usage_stats(scope_type, scope_id, date desc);
create index idx_usage_stats_date         on public.usage_stats(date desc);
create index idx_enterprise_config_team   on public.enterprise_config(team_id);
```

---

### Sub-Task 3 — Agent Modules (TypeScript Utilities)

**Status:** [ ] pending

**Intent:**
Implement the five internal agent modules as stateless TypeScript utility classes/functions
in `src/lib/agents/`. These are **not separate processes** — they are plain TypeScript modules
imported directly into `createServerFn` server functions.

**Expected Outcomes:**
- `src/lib/agents/BillingAgent.ts`
- `src/lib/agents/UsageAgent.ts`
- `src/lib/agents/RateLimitAgent.ts`
- `src/lib/agents/EnterpriseAgent.ts`
- `src/lib/agents/AdminAgent.ts`
- `src/lib/agents/errors.ts` — shared error type definitions
- `src/lib/agents/index.ts` — barrel export

**Todo List:**

#### `errors.ts`
Define the discriminated union of all billing errors:
```typescript
export type BillingErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'RATE_LIMIT'
  | 'ENTERPRISE_SOFT_CAP'
  | 'ENTERPRISE_HARD_CAP'
  | 'GLOBAL_CAP_REACHED'
  | 'TEAM_SUSPENDED'
  | 'AI_GATEWAY_ERROR';

export class BillingError extends Error {
  constructor(
    public readonly code: BillingErrorCode,
    public readonly message: string,
    public readonly meta?: Record<string, unknown>
  ) { super(message); }
}
```

All server functions catch `BillingError` and return `{ error: code, message }`.

#### `BillingAgent.ts`
Responsibilities:
- `resolveWallet(userId, teamId, billingType)` — returns the active wallet (team wallet for PAYG teams, user wallet otherwise). Creates wallet if missing.
- `checkBalance(walletId, costCents)` — throws `INSUFFICIENT_FUNDS` if balance is below cost
- `deductBalance(walletId, costCents, messageId)` — atomically decrements `balance_cents` and inserts a `message_debit` transaction. Use a Postgres function/RPC to make this atomic.
- `creditWallet(walletId, amountCents, type, meta)` — increments `balance_cents` and inserts transaction

Atomicity rule: `deductBalance` must be a single Supabase RPC call (Postgres function) to
prevent race conditions where two concurrent messages both pass the balance check before either
deducts. The Postgres function should use `FOR UPDATE` row lock.

#### `UsageAgent.ts`
Responsibilities:
- `incrementUsage(userId, teamId, tokensIn, tokensOut)` — upserts `usage_stats` for user scope, team scope, and global scope for today's date. Use `ON CONFLICT (scope_type, scope_id, date) DO UPDATE` to atomically increment counters.
- `getUserUsage(userId, startDate, endDate)` — returns aggregated usage for date range
- `getTeamUsage(teamId, startDate, endDate)` — returns aggregated team usage
- `getGlobalUsage(date)` — returns global usage row for a given date

#### `RateLimitAgent.ts`
Responsibilities:
- `checkPerUserRateLimit(userId)` — reads `usage_stats` for today, and checks `last_message_at` to enforce minimum delay (3 seconds default). Throws `RATE_LIMIT` if violated.
- `checkPerUserMinuteLimit(userId, maxPerMinute)` — counts messages in the last 60 seconds. Since `usage_stats` is daily, this requires a secondary check: read the last N `transactions` for the user's wallet in the past 60 seconds, or store a Redis-style counter. **Implementation decision:** use a lightweight `rate_limit_events` table with `(user_id, timestamp)` and clean up entries older than 60 seconds on each check. Alternatively, use Supabase Realtime or a Postgres function. Simplest approach: insert a row per message into `rate_limit_events` and `count(*)` where `created_at > now() - interval '1 minute'`.
- `checkGlobalDailyCap()` — reads `usage_stats` where `scope_type = 'global'` for today. Throws `GLOBAL_CAP_REACHED` if `messages_count >= GLOBAL_DAILY_CAP` (default 50,000).

**`rate_limit_events` table** (add to migration 0001):
```sql
create table public.rate_limit_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id),
  created_at timestamptz not null default now()
);
create index idx_rle_user_created on public.rate_limit_events(user_id, created_at desc);
```
A Postgres cron job (pg_cron) or cleanup on read removes rows older than 2 minutes.

#### `EnterpriseAgent.ts`
Responsibilities:
- `checkEnterpriseStatus(teamId)` — reads `enterprise_config.status`. Throws `TEAM_SUSPENDED` if suspended.
- `checkDailyCaps(teamId, config)` — reads today's team `usage_stats`. If `messages_count >= daily_hard_cap_messages`, throws `ENTERPRISE_HARD_CAP`. If `>= daily_soft_cap_messages`, throws `ENTERPRISE_SOFT_CAP` (throttle, not block).
- `checkMonthlyCaps(teamId, config)` — sums team `usage_stats` for current month. Same soft/hard logic.
- `checkBurstLimit(userId, config)` — delegates to `RateLimitAgent.checkPerUserMinuteLimit` with `config.burst_limit_per_user`
- `setThrottled(teamId)` — updates `enterprise_config.status = 'throttled'`
- `setSuspended(teamId)` — updates `enterprise_config.status = 'suspended'`
- `setActive(teamId)` — updates `enterprise_config.status = 'active'`

Soft cap behavior: `ENTERPRISE_SOFT_CAP` is **not a hard block** — the message is still sent,
but the response includes a warning flag `{ softCapWarning: true }` and the team status is set
to `'throttled'`. Hard cap blocks the message entirely.

#### `AdminAgent.ts`
Responsibilities:
- `getTeamList(options)` — paginated list of teams with usage + wallet + status joined
- `getTeamDetail(teamId)` — single team with full config, wallet, recent transactions, usage
- `getAllUsers(teamId)` — users belonging to a team
- `getAlerts()` — teams near soft caps, teams throttled/suspended, global cap percentage
- `applyWalletAdjustment(walletId, amountCents, adminUserId, reason)` — creates `admin_adjustment` transaction
- `updateEnterpriseConfig(teamId, config)` — writes new limits to `enterprise_config`

---

### Sub-Task 4 — Server Functions

**Status:** [ ] pending

**Intent:**
Implement all `createServerFn` server functions in `src/server/`. Each function imports the
relevant agent modules and Supabase server client. These are the only entry points through
which client React code accesses billing data.

**Expected Outcomes:**
- `src/server/billing.ts` — `getWallet`, `purchaseCredits`, `adminAdjustWallet`
- `src/server/messaging.ts` — `sendMessage`
- `src/server/usage.ts` — `getMyUsage`, `getTeamUsage`
- `src/server/admin.ts` — `getAdminTeams`, `getAdminTeamDetails`, `updateTeamLimits`, `throttleTeam`, `suspendTeam`
- `src/server/auth.ts` — shared auth helper `requireAuth()` and `requireAdmin()`

**Todo List:**

#### Auth helpers (`src/server/auth.ts`)
```typescript
// requireAuth() — reads the session from Supabase, throws if unauthenticated
// Returns { userId, teamId, billingType, role }
async function requireAuth(): Promise<AuthContext>

// requireAdmin() — calls requireAuth(), then checks role === 'admin'
async function requireAdmin(): Promise<AuthContext>
```

#### `getWallet`
- Input: none (user inferred from session)
- Auth: `requireAuth()`
- Logic: `BillingAgent.resolveWallet(userId, teamId, billingType)`
- Returns: `{ wallet: Wallet }`
- Error: `{ error: 'NOT_FOUND', message: 'No wallet found' }`

#### `purchaseCredits`
- Input: `{ amountCents: number, paymentMethodId: string }`
- Auth: `requireAuth()`
- Logic:
  1. Process payment via Stripe (server-side, `paymentMethodId`)
  2. On Stripe success: `BillingAgent.creditWallet(walletId, amountCents, 'credit_purchase', { stripePaymentId })`
- Returns: `{ wallet: Wallet, transaction: Transaction }`
- Error: `{ error: 'PAYMENT_FAILED', message: string }`
- Multi-tenant safety: wallet must belong to the authenticated user's team or user

#### `adminAdjustWallet`
- Input: `{ walletId: string, amountCents: number, reason: string }`
- Auth: `requireAdmin()`
- Logic: `AdminAgent.applyWalletAdjustment(walletId, amountCents, adminUserId, reason)`
- Returns: `{ wallet: Wallet, transaction: Transaction }`

#### `sendMessage` (core endpoint)
See Sub-Task 5 for the full workflow. Server function signature:
- Input: `{ messages: ChatMessage[], conversationId?: string }`
- Auth: `requireAuth()`
- Returns: `{ response: string, usage: UsageSummary, balance?: number, softCapWarning?: boolean }`
- On error: `{ error: BillingErrorCode, message: string }`

#### `getMyUsage`
- Input: `{ startDate?: string, endDate?: string }`
- Auth: `requireAuth()`
- Logic: `UsageAgent.getUserUsage(userId, startDate, endDate)`
- Returns: `{ usage: UsageStat[] }`

#### `getTeamUsage`
- Input: `{ teamId: string, startDate?: string, endDate?: string }`
- Auth: `requireAuth()` — verifies user belongs to `teamId`
- Logic: `UsageAgent.getTeamUsage(teamId, startDate, endDate)`
- Returns: `{ usage: UsageStat[] }`

#### `getAdminTeams`
- Input: `{ page?: number, pageSize?: number, filter?: { status?, billingType? } }`
- Auth: `requireAdmin()`
- Logic: `AdminAgent.getTeamList(options)`
- Returns: `{ teams: TeamSummary[], total: number }`

#### `getAdminTeamDetails`
- Input: `{ teamId: string }`
- Auth: `requireAdmin()`
- Logic: `AdminAgent.getTeamDetail(teamId)`
- Returns: `{ team: TeamDetail }`

#### `updateTeamLimits`
- Input: `{ teamId: string, config: Partial<EnterpriseConfig> }`
- Auth: `requireAdmin()`
- Logic: `AdminAgent.updateEnterpriseConfig(teamId, config)`
- Returns: `{ config: EnterpriseConfig }`

#### `throttleTeam`
- Input: `{ teamId: string }`
- Auth: `requireAdmin()`
- Logic: `EnterpriseAgent.setThrottled(teamId)`
- Returns: `{ status: 'throttled' }`

#### `suspendTeam`
- Input: `{ teamId: string }`
- Auth: `requireAdmin()`
- Logic: `EnterpriseAgent.setSuspended(teamId)`
- Returns: `{ status: 'suspended' }`

**Multi-tenant safety rule (applies to all functions):**
Every server function that accepts a `teamId` must verify the authenticated user belongs to
that team (or is admin) before performing any operation. Use the pattern:
```typescript
const { teamId: userTeamId } = await requireAuth();
if (input.teamId !== userTeamId) throw new BillingError('FORBIDDEN', '...');
```

---

### Sub-Task 5 — `sendMessage` Workflow + LinX Echo Integration

**Status:** [ ] pending

**Intent:**
Implement the full `sendMessage` server function — the critical path that orchestrates all
agents and calls LinX Echo. Every AI message in the system flows through this function.

**Expected Outcomes:**
- Complete `sendMessage` implementation in `src/server/messaging.ts`
- `src/lib/echoClient.ts` — typed HTTP client for LinX Echo
- Correct sequencing: auth → rate limits → enterprise checks → wallet check → AI call → usage log → deduct

**Todo List:**

#### Step-by-step implementation of `sendMessage`:

**Step 1 — Authenticate**
```typescript
const auth = await requireAuth();
// auth = { userId, teamId, billingType, role }
```

**Step 2 — Resolve billing context**
```typescript
const wallet = billingType === 'payg'
  ? await BillingAgent.resolveWallet(userId, teamId, billingType)
  : null;
const enterpriseConfig = billingType === 'enterprise'
  ? await EnterpriseAgent.getConfig(teamId)
  : null;
```

**Step 3 — RateLimitAgent checks (always run, regardless of billing type)**
```typescript
await RateLimitAgent.checkGlobalDailyCap();
await RateLimitAgent.checkPerUserRateLimit(userId);  // 3-second delay check
const maxPerMin = enterpriseConfig?.rate_limit_per_user_per_minute ?? 20;
await RateLimitAgent.checkPerUserMinuteLimit(userId, maxPerMin);
```

**Step 4 — EnterpriseAgent checks (enterprise teams only)**
```typescript
if (billingType === 'enterprise') {
  await EnterpriseAgent.checkEnterpriseStatus(teamId);  // throws TEAM_SUSPENDED
  await EnterpriseAgent.checkDailyCaps(teamId, enterpriseConfig);  // throws HARD/SOFT_CAP
  await EnterpriseAgent.checkMonthlyCaps(teamId, enterpriseConfig);
  await EnterpriseAgent.checkBurstLimit(userId, enterpriseConfig);
}
```

**Step 5 — PAYG balance check**
```typescript
if (billingType === 'payg') {
  const cost = parseInt(process.env.COST_PER_MESSAGE_CENTS ?? '1');
  await BillingAgent.checkBalance(wallet.id, cost);  // throws INSUFFICIENT_FUNDS
}
```

**Step 6 — Call LinX Echo**
```typescript
const echoResponse = await echoClient.sendMessage({
  messages,
  userId,
  teamId,
  conversationId,
  meta: { billingType }
});
// echoResponse = { content: string, tokensIn: number, tokensOut: number, messageId: string }
// On fetch failure or non-200: throw new BillingError('AI_GATEWAY_ERROR', ...)
```

**Step 7 — Log usage (always, even on throttled soft-cap)**
```typescript
await UsageAgent.incrementUsage(userId, teamId, echoResponse.tokensIn, echoResponse.tokensOut);
await RateLimitAgent.recordEvent(userId);  // insert into rate_limit_events
```

**Step 8 — PAYG deduction (only after successful AI response)**
```typescript
if (billingType === 'payg') {
  const cost = parseInt(process.env.COST_PER_MESSAGE_CENTS ?? '1');
  await BillingAgent.deductBalance(wallet.id, cost, echoResponse.messageId);
}
```

**Step 9 — Return response**
```typescript
return {
  response: echoResponse.content,
  usage: { tokensIn: echoResponse.tokensIn, tokensOut: echoResponse.tokensOut },
  balance: billingType === 'payg' ? wallet.balance_cents - cost : undefined,
  softCapWarning: softCapTriggered  // boolean set during step 4
};
```

#### LinX Echo HTTP client (`src/lib/echoClient.ts`)

```typescript
interface EchoRequest {
  messages: ChatMessage[];
  userId: string;
  teamId: string | null;
  conversationId?: string;
  meta?: Record<string, unknown>;
}

interface EchoResponse {
  content: string;
  tokensIn: number;
  tokensOut: number;
  messageId: string;
}

async function sendMessage(payload: EchoRequest): Promise<EchoResponse> {
  const res = await fetch(process.env.LINX_ECHO_URL + '/v1/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.LINX_ECHO_SECRET}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000)  // 30-second timeout
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new BillingError('AI_GATEWAY_ERROR', `LinX Echo returned ${res.status}: ${body}`);
  }

  return res.json() as Promise<EchoResponse>;
}
```

**Error handling rules for LinX Echo:**
- HTTP 4xx (client error) — throw `AI_GATEWAY_ERROR` with status code in message
- HTTP 5xx (server error) — throw `AI_GATEWAY_ERROR`, do NOT deduct wallet
- Network timeout (AbortSignal) — throw `AI_GATEWAY_ERROR`
- Malformed JSON response — throw `AI_GATEWAY_ERROR`
- In all `AI_GATEWAY_ERROR` cases: usage is NOT logged, wallet is NOT deducted

**Important:** If LinX Echo returns token counts as `0` or undefined (e.g. a streaming
endpoint), log `0` for `tokens_in`/`tokens_out` in `usage_stats` — never block on missing
token data.

---

### Sub-Task 6 — Admin Dashboard Integration

**Status:** [ ] pending

**Intent:**
Wire the existing mock admin UI pages to the new server functions. Replace `mockRevenue`,
`mockUsers`, etc. with live data from Supabase. The existing `Card`, `Table`, `Badge`,
`StatCard` components are preserved unchanged.

**Expected Outcomes:**
- `src/pages/Revenue.tsx` — displays live MRR/wallet data
- `src/pages/Subscriptions.tsx` — displays live team/user plan data
- `src/pages/Users.tsx` — displays live users with usage and wallet balance
- New page: `src/pages/BillingAdmin.tsx` — team wallets, transactions, adjustments
- New page: `src/pages/UsageAdmin.tsx` — global usage, daily caps, alerts
- All pages use TanStack Router loaders that call server functions
- `src/App.tsx` updated to add new page keys and routes

**Todo List:**

1. Add TanStack Router to the project (`@tanstack/react-router`)
2. Convert `src/App.tsx` from `useState` routing to `RouterProvider`
3. Create route files under `src/routes/` for each admin page
4. Each route exports a `loader` that calls the relevant server function:
   ```typescript
   export const loader = createServerFn().handler(async () => {
     return getAdminTeams({ page: 1, pageSize: 25 });
   });
   ```
5. Replace `mockRevenue` imports in `Revenue.tsx` with `useLoaderData()` 
6. Replace `mockUsers` imports in `Users.tsx` with `useLoaderData()`
7. Create `BillingAdmin.tsx`:
   - Team list with billing type, wallet balance, status badges
   - Wallet adjustment form (calls `adminAdjustWallet`)
   - Transaction history table (paginated)
8. Create `UsageAdmin.tsx`:
   - Global daily usage bar vs cap
   - Team usage table (sortable, filterable)
   - Alert panel: throttled/suspended teams, teams >80% of soft cap
9. Update `Sidebar.tsx` to add "Billing" and "Usage" nav items

**Admin alert logic:**
Alerts surface in `UsageAdmin.tsx` when:
- Team daily `messages_count / daily_soft_cap_messages >= 0.8` (near cap warning)
- `enterprise_config.status = 'throttled'`
- `enterprise_config.status = 'suspended'`
- Global daily messages > 80% of `GLOBAL_DAILY_CAP`

---

### Sub-Task 7 — Error Protocol Implementation

**Status:** [ ] pending

**Intent:**
Implement a consistent error handling layer that maps `BillingError` codes to user-facing
messages, admin resolution hints, and HTTP-style response shapes.

**Expected Outcomes:**
- `src/lib/errors/errorMessages.ts` — user-facing copy for each error code
- `src/lib/errors/adminHints.ts` — admin resolution instructions per code
- `src/components/UI/BillingErrorBanner.tsx` — React component that renders error states
- All server functions return `{ error: BillingErrorCode, message: string }` on failure

**Todo List:**

#### Error definitions

| Code | Trigger | User Message | Admin Resolution |
|------|---------|-------------|-----------------|
| `INSUFFICIENT_FUNDS` | `balance_cents < COST_PER_MESSAGE_CENTS` | "You've run out of credits. Purchase more to continue." | Add credits via wallet adjustment or prompt user to purchase |
| `RATE_LIMIT` | Messages too fast (< 3s gap or > 20/min) | "You're sending messages too quickly. Please slow down." | Increase `rate_limit_per_user_per_minute` in enterprise config |
| `ENTERPRISE_SOFT_CAP` | Daily/monthly count >= soft cap | "Your team is near its message limit. Some features may be slower." | Raise soft cap in enterprise config, or upgrade plan |
| `ENTERPRISE_HARD_CAP` | Daily/monthly count >= hard cap | "Your team has reached its message limit for today. Contact your admin." | Raise hard cap, wait for daily reset, or manually reset counter |
| `GLOBAL_CAP_REACHED` | Global messages >= 50,000/day | "The platform is experiencing high demand. Please try again later." | Raise `GLOBAL_DAILY_CAP` env var, investigate LinX Echo capacity |
| `TEAM_SUSPENDED` | `enterprise_config.status = 'suspended'` | "Your team account has been suspended. Contact support." | Call `suspendTeam`/`throttleTeam` reverse action, investigate reason |
| `AI_GATEWAY_ERROR` | LinX Echo non-200 or timeout | "The AI service is temporarily unavailable. Please try again." | Check LinX Echo Worker health, review encrypted logs in LinX Echo |

#### Response shape contract
Every server function must return one of:
```typescript
// Success
{ data: T }

// Failure  
{ error: BillingErrorCode | string, message: string }
```
Client React code checks `if ('error' in result)` to determine success/failure.

---

### Sub-Task 8 — Environment Config + Security Hardening

**Status:** [ ] pending

**Intent:**
Ensure all secrets are correctly scoped, RLS is the final defence layer, and no client-side
code ever touches the service role key.

**Expected Outcomes:**
- `.env.example` documenting all required variables
- `src/lib/env.ts` — typed env accessor that throws on missing required vars at startup
- Confirmation that `SUPABASE_SERVICE_ROLE_KEY` is only referenced in `src/lib/supabase/server.ts`
- Confirmation that `LINX_ECHO_SECRET` is only referenced in `src/lib/echoClient.ts`
- Supabase RLS verified: a direct SQL test confirms cross-team data is inaccessible

**Todo List:**

1. Create `.env.example`:
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...          # NEVER expose to browser
LINX_ECHO_URL=https://echo.your-worker.workers.dev
LINX_ECHO_SECRET=your-shared-secret       # NEVER expose to browser
COST_PER_MESSAGE_CENTS=1
GLOBAL_DAILY_CAP=50000
STRIPE_SECRET_KEY=sk_live_...             # server only
STRIPE_PUBLISHABLE_KEY=pk_live_...        # safe for browser
```

2. Create `src/lib/env.ts`:
```typescript
function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}
export const env = {
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseAnonKey: requireEnv('SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  linxEchoUrl: requireEnv('LINX_ECHO_URL'),
  linxEchoSecret: requireEnv('LINX_ECHO_SECRET'),
  costPerMessageCents: parseInt(process.env.COST_PER_MESSAGE_CENTS ?? '1'),
  globalDailyCap: parseInt(process.env.GLOBAL_DAILY_CAP ?? '50000'),
};
```

3. In TanStack Start's `app.config.ts`, mark server-only env vars so Vite never bundles them
   into the client bundle. Use the `server` option in TanStack Start config.

4. Write a Supabase RLS smoke test: create two test users in different teams, verify that
   querying `wallets` as user A returns no rows belonging to user B's team.

---

## Architecture Diagram Reference (for Lovable)

```
Browser / React UI
       │
       │ useLoaderData() / server function calls
       ▼
createServerFn() handlers  ←── requireAuth() / requireAdmin()
       │
       ├── RateLimitAgent ──► usage_stats, rate_limit_events
       ├── EnterpriseAgent ──► enterprise_config
       ├── BillingAgent ───► wallets, transactions
       ├── UsageAgent ─────► usage_stats
       └── AdminAgent ─────► all tables (admin only)
                │
                │  (after all checks pass)
                ▼
         LinX Echo (Cloudflare Worker)
         POST /v1/chat { messages, userId, teamId }
                │
                ▼
         AI Response { content, tokensIn, tokensOut, messageId }
                │
                ▼
         UsageAgent.incrementUsage()
         BillingAgent.deductBalance()  (PAYG only)
```

---

## File Structure Reference (for Lovable)

```
linx-site/
├── app.config.ts                        # TanStack Start config
├── supabase/
│   └── migrations/
│       ├── 0001_billing_schema.sql
│       ├── 0002_rls_policies.sql
│       └── 0003_indexes.sql
├── src/
│   ├── lib/
│   │   ├── supabase/
│   │   │   ├── client.ts               # Browser Supabase client
│   │   │   ├── server.ts               # Server Supabase client (service role)
│   │   │   └── types.ts                # Generated DB types
│   │   ├── agents/
│   │   │   ├── BillingAgent.ts
│   │   │   ├── UsageAgent.ts
│   │   │   ├── RateLimitAgent.ts
│   │   │   ├── EnterpriseAgent.ts
│   │   │   ├── AdminAgent.ts
│   │   │   ├── errors.ts
│   │   │   └── index.ts
│   │   ├── echoClient.ts               # LinX Echo HTTP client
│   │   └── env.ts                      # Typed env accessor
│   ├── server/
│   │   ├── auth.ts                     # requireAuth, requireAdmin
│   │   ├── billing.ts                  # getWallet, purchaseCredits, adminAdjustWallet
│   │   ├── messaging.ts                # sendMessage
│   │   ├── usage.ts                    # getMyUsage, getTeamUsage
│   │   └── admin.ts                    # getAdminTeams, etc.
│   ├── routes/                         # TanStack Router file-based routes
│   │   ├── __root.tsx
│   │   ├── index.tsx                   # Overview
│   │   ├── billing.tsx
│   │   ├── usage.tsx
│   │   └── ...
│   ├── pages/                          # Existing pages (updated to use live data)
│   │   ├── BillingAdmin.tsx            # NEW
│   │   ├── UsageAdmin.tsx              # NEW
│   │   └── ... (existing pages updated)
│   └── components/
│       └── UI/
│           ├── BillingErrorBanner.tsx  # NEW
│           └── ... (existing components unchanged)
└── .env.example
```

---

## Implementation Order for Lovable

Execute sub-tasks in this exact order — each one depends on the previous:

1. **Sub-Task 1** — Bootstrap: Supabase client, TanStack Start config, env vars
2. **Sub-Task 2** — Schema: Run migrations, verify tables + RLS in Supabase Studio
3. **Sub-Task 3** — Agents: Implement all five agent modules (no UI yet)
4. **Sub-Task 4** — Server Functions: Wire agents to `createServerFn` endpoints
5. **Sub-Task 5** — `sendMessage`: Full workflow + LinX Echo client
6. **Sub-Task 6** — Admin UI: Replace mock data with live server function calls
7. **Sub-Task 7** — Errors: Error protocol, user messages, `BillingErrorBanner`
8. **Sub-Task 8** — Security: Env hardening, RLS smoke test, secrets audit
