-- ============================================================
-- LinX Billing Engine — Migration 0003: Performance Indexes
-- ============================================================

-- users
create index if not exists idx_users_team_id
  on public.users(team_id)
  where team_id is not null;

create index if not exists idx_users_role
  on public.users(role);

-- teams
create index if not exists idx_teams_owner_user_id
  on public.teams(owner_user_id);

create index if not exists idx_teams_billing_type
  on public.teams(billing_type);

create index if not exists idx_teams_wallet_id
  on public.teams(wallet_id)
  where wallet_id is not null;

-- wallets
create index if not exists idx_wallets_owner
  on public.wallets(owner_type, owner_id);

-- transactions
create index if not exists idx_transactions_wallet_id
  on public.transactions(wallet_id);

create index if not exists idx_transactions_created_at
  on public.transactions(created_at desc);

create index if not exists idx_transactions_type
  on public.transactions(type);

-- usage_stats (critical path — queried on every message)
create index if not exists idx_usage_stats_scope
  on public.usage_stats(scope_type, scope_id, date desc);

create index if not exists idx_usage_stats_date
  on public.usage_stats(date desc);

-- Partial index for global cap check (most frequent admin query)
create index if not exists idx_usage_stats_global_today
  on public.usage_stats(date desc)
  where scope_type = 'global';

-- enterprise_config
create index if not exists idx_enterprise_config_team
  on public.enterprise_config(team_id);

create index if not exists idx_enterprise_config_status
  on public.enterprise_config(status);

-- rate_limit_events (critical path — queried on every message send)
create index if not exists idx_rle_user_created
  on public.rate_limit_events(user_id, created_at desc);

-- Partial index for recent-only lookups (last 2 minutes)
-- The planner will use this for per-minute rate checks
create index if not exists idx_rle_recent
  on public.rate_limit_events(user_id, created_at desc)
  where created_at > (now() - interval '2 minutes');
