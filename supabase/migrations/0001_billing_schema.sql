-- ============================================================
-- LinX Billing Engine — Migration 0001: Schema
-- ============================================================

-- NOTE: Tables are created in dependency order.
-- wallets and enterprise_config must exist before teams can
-- reference them, but teams must exist before users can reference
-- teams. We resolve this with deferred FK constraints where needed,
-- or by creating in correct order with nullable FKs added later.

-- ============================================================
-- 1. wallets (no deps)
-- ============================================================
create table if not exists public.wallets (
  id                      uuid primary key default gen_random_uuid(),
  owner_type              text not null check (owner_type in ('user', 'team')),
  owner_id                uuid not null,
  balance_cents           bigint not null default 0 check (balance_cents >= 0),
  currency                text not null default 'USD',
  daily_soft_limit_cents  bigint,
  daily_hard_limit_cents  bigint,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table public.wallets is 'Credit wallets for users and teams (PAYG billing)';
comment on column public.wallets.owner_type is 'user or team';
comment on column public.wallets.owner_id is 'UUID of owning user or team';
comment on column public.wallets.balance_cents is 'Current balance in smallest currency unit (cents)';

-- ============================================================
-- 2. teams (references wallets — nullable)
-- enterprise_config added below after that table is created
-- ============================================================
create table if not exists public.teams (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  owner_user_id         uuid not null,  -- FK to users added after users table
  billing_type          text not null default 'payg' check (billing_type in ('payg', 'enterprise')),
  wallet_id             uuid references public.wallets(id) on delete set null,
  enterprise_config_id  uuid,           -- FK added after enterprise_config table
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.teams is 'Tenant teams. billing_type determines PAYG vs enterprise logic.';

-- ============================================================
-- 3. users (references auth.users and teams)
-- ============================================================
create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  role        text not null default 'user' check (role in ('user', 'admin')),
  team_id     uuid references public.teams(id) on delete set null,
  plan        text not null default 'free' check (plan in ('free', 'starter', 'pro', 'enterprise')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.users is 'App-level user profiles. id mirrors auth.users.id.';
comment on column public.users.role is 'user or admin — controls access to admin server functions';

-- Now add the owner_user_id FK on teams → users
alter table public.teams
  add constraint teams_owner_user_id_fkey
  foreign key (owner_user_id) references public.users(id);

-- ============================================================
-- 4. enterprise_config (references teams)
-- ============================================================
create table if not exists public.enterprise_config (
  id                              uuid primary key default gen_random_uuid(),
  team_id                         uuid not null unique references public.teams(id) on delete cascade,
  daily_soft_cap_messages         integer not null default 1000,
  daily_hard_cap_messages         integer not null default 2000,
  monthly_soft_cap_messages       integer not null default 20000,
  monthly_hard_cap_messages       integer not null default 40000,
  rate_limit_per_user_per_minute  integer not null default 20,
  burst_limit_per_user            integer not null default 5,
  status                          text not null default 'active'
                                    check (status in ('active', 'throttled', 'suspended')),
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

comment on table public.enterprise_config is 'Rate limit and cap configuration for enterprise teams.';
comment on column public.enterprise_config.status is 'active | throttled | suspended';

-- Now add the enterprise_config_id FK on teams → enterprise_config
alter table public.teams
  add constraint teams_enterprise_config_id_fkey
  foreign key (enterprise_config_id) references public.enterprise_config(id) on delete set null;

-- ============================================================
-- 5. transactions (references wallets)
-- ============================================================
create table if not exists public.transactions (
  id            uuid primary key default gen_random_uuid(),
  wallet_id     uuid not null references public.wallets(id) on delete restrict,
  type          text not null check (type in ('credit_purchase', 'message_debit', 'admin_adjustment')),
  amount_cents  bigint not null,  -- positive = credit, negative = debit
  message_id    uuid,             -- optional reference to the AI message that caused this debit
  meta          jsonb not null default '{}',
  created_at    timestamptz not null default now()
);

comment on table public.transactions is 'Immutable ledger of all wallet movements.';
comment on column public.transactions.amount_cents is 'Positive for credits, negative for debits.';

-- ============================================================
-- 6. usage_stats (no FK — scope_id is polymorphic text)
-- ============================================================
create table if not exists public.usage_stats (
  id              uuid primary key default gen_random_uuid(),
  scope_type      text not null check (scope_type in ('user', 'team', 'global')),
  scope_id        text not null,  -- user UUID, team UUID, or literal 'global'
  date            date not null,
  messages_count  integer not null default 0,
  tokens_in       integer not null default 0,
  tokens_out      integer not null default 0,
  last_message_at timestamptz,
  unique (scope_type, scope_id, date)
);

comment on table public.usage_stats is 'Daily usage counters per user, team, and global. Used for rate limiting and cap enforcement.';
comment on column public.usage_stats.scope_id is 'UUID as text for user/team scope, or literal "global" for platform-wide.';

-- ============================================================
-- 7. rate_limit_events (references users — rolling 2-minute window)
-- ============================================================
create table if not exists public.rate_limit_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);

comment on table public.rate_limit_events is 'Short-lived per-user message events for per-minute rate limiting. Rows older than 2 minutes are safe to purge.';

-- ============================================================
-- 8. Auth trigger — auto-create users row on signup
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- 9. Atomic deduct_wallet_balance Postgres RPC
-- Called by BillingAgent.deductBalance — uses FOR UPDATE to
-- prevent race conditions on concurrent message sends.
-- ============================================================
create or replace function public.deduct_wallet_balance(
  p_wallet_id   uuid,
  p_cost_cents  bigint,
  p_message_id  uuid default null
)
returns table (new_balance_cents bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_balance bigint;
begin
  -- Lock the wallet row for this transaction
  select balance_cents into v_current_balance
  from public.wallets
  where id = p_wallet_id
  for update;

  if not found then
    raise exception 'WALLET_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_current_balance < p_cost_cents then
    raise exception 'INSUFFICIENT_FUNDS' using errcode = 'P0002';
  end if;

  -- Deduct balance
  update public.wallets
  set balance_cents = balance_cents - p_cost_cents,
      updated_at    = now()
  where id = p_wallet_id;

  -- Insert debit transaction
  insert into public.transactions (wallet_id, type, amount_cents, message_id)
  values (p_wallet_id, 'message_debit', -p_cost_cents, p_message_id);

  return query select (v_current_balance - p_cost_cents)::bigint;
end;
$$;

comment on function public.deduct_wallet_balance is 'Atomically deducts balance and inserts message_debit transaction. Raises P0002 on insufficient funds.';

-- ============================================================
-- 10. credit_wallet Postgres RPC
-- Called by BillingAgent.creditWallet
-- ============================================================
create or replace function public.credit_wallet(
  p_wallet_id    uuid,
  p_amount_cents bigint,
  p_type         text,
  p_meta         jsonb default '{}'
)
returns table (new_balance_cents bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.wallets
  set balance_cents = balance_cents + p_amount_cents,
      updated_at    = now()
  where id = p_wallet_id;

  if not found then
    raise exception 'WALLET_NOT_FOUND' using errcode = 'P0001';
  end if;

  insert into public.transactions (wallet_id, type, amount_cents, meta)
  values (p_wallet_id, p_type, p_amount_cents, p_meta);

  return query
    select balance_cents from public.wallets where id = p_wallet_id;
end;
$$;
