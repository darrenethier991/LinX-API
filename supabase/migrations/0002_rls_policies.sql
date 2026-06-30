-- ============================================================
-- LinX Billing Engine — Migration 0002: RLS Policies
-- ============================================================
-- All tables use Row Level Security.
-- Service role key (server functions) bypasses RLS entirely.
-- Browser client (anon key) is subject to all policies below.
-- ============================================================

-- Enable RLS on all billing tables
alter table public.users             enable row level security;
alter table public.teams             enable row level security;
alter table public.wallets           enable row level security;
alter table public.transactions      enable row level security;
alter table public.usage_stats       enable row level security;
alter table public.enterprise_config enable row level security;
alter table public.rate_limit_events enable row level security;

-- ============================================================
-- Helper: is_admin()
-- Returns true if the current auth.uid() has role = 'admin'
-- ============================================================
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role = 'admin'
  );
$$;

-- Helper: my_team_id()
-- Returns the team_id of the currently authenticated user
create or replace function public.my_team_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select team_id from public.users where id = auth.uid();
$$;

-- ============================================================
-- users
-- ============================================================

-- Users can read their own row; admins can read all rows
create policy users_select_own on public.users
  for select
  using (id = auth.uid() or public.is_admin());

-- Users can update their own row but cannot escalate role
create policy users_update_own on public.users
  for update
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.users where id = auth.uid()));

-- Admins can update any user (e.g. change plan, role)
create policy users_update_admin on public.users
  for update
  using (public.is_admin());

-- ============================================================
-- teams
-- ============================================================

-- Team members (and admins) can read their own team
create policy teams_select_member on public.teams
  for select
  using (id = public.my_team_id() or public.is_admin());

-- Only admins can insert teams (or the owner themselves via server fn)
create policy teams_insert_server on public.teams
  for insert
  with check (public.is_admin() or owner_user_id = auth.uid());

-- Team owner or admin can update team record
create policy teams_update_owner on public.teams
  for update
  using (owner_user_id = auth.uid() or public.is_admin());

-- ============================================================
-- wallets
-- ============================================================

-- User wallet: user can see their own
-- Team wallet: user can see their team's wallet
-- Admins can see all
create policy wallets_select_own on public.wallets
  for select
  using (
    (owner_type = 'user'  and owner_id = auth.uid()) or
    (owner_type = 'team'  and owner_id = public.my_team_id()) or
    public.is_admin()
  );

-- No direct insert/update/delete from client — wallets are
-- modified only via server-side RPC functions (service role bypasses RLS)

-- ============================================================
-- transactions
-- ============================================================

-- Users can read transactions for wallets they can see
create policy transactions_select_own on public.transactions
  for select
  using (
    public.is_admin() or
    wallet_id in (
      select id from public.wallets
      where
        (owner_type = 'user' and owner_id = auth.uid()) or
        (owner_type = 'team' and owner_id = public.my_team_id())
    )
  );

-- No client-side writes — transactions are created only via server RPCs

-- ============================================================
-- usage_stats
-- ============================================================

-- User scope: user can see their own usage
-- Team scope: user can see their team's usage
-- Global scope: admin only
create policy usage_select_own on public.usage_stats
  for select
  using (
    (scope_type = 'user'   and scope_id = auth.uid()::text) or
    (scope_type = 'team'   and scope_id = public.my_team_id()::text) or
    (scope_type = 'global' and public.is_admin()) or
    public.is_admin()
  );

-- No client-side writes

-- ============================================================
-- enterprise_config
-- ============================================================

-- Team members can read their own enterprise config
-- Admins can read/write all configs
create policy ec_select_member on public.enterprise_config
  for select
  using (team_id = public.my_team_id() or public.is_admin());

create policy ec_update_admin on public.enterprise_config
  for update
  using (public.is_admin());

create policy ec_insert_admin on public.enterprise_config
  for insert
  with check (public.is_admin());

-- ============================================================
-- rate_limit_events
-- ============================================================

-- Users can see only their own events; no client writes
create policy rle_select_own on public.rate_limit_events
  for select
  using (user_id = auth.uid() or public.is_admin());
