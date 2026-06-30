-- ============================================================
-- LinX Billing Engine — Migration 0004: UsageAgent RPC
-- increment_usage_stat — called by UsageAgent.incrementUsage
-- Atomically increments usage_stats via ON CONFLICT DO UPDATE
-- ============================================================

create or replace function public.increment_usage_stat(
  p_scope_type  text,
  p_scope_id    text,
  p_date        date,
  p_tokens_in   integer default 0,
  p_tokens_out  integer default 0,
  p_now         timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.usage_stats
    (scope_type, scope_id, date, messages_count, tokens_in, tokens_out, last_message_at)
  values
    (p_scope_type, p_scope_id, p_date, 1, p_tokens_in, p_tokens_out, p_now)
  on conflict (scope_type, scope_id, date) do update
    set messages_count  = usage_stats.messages_count  + 1,
        tokens_in       = usage_stats.tokens_in       + excluded.tokens_in,
        tokens_out      = usage_stats.tokens_out      + excluded.tokens_out,
        last_message_at = excluded.last_message_at;
end;
$$;

comment on function public.increment_usage_stat is
  'Atomically upserts a daily usage_stats row. Called by UsageAgent after every successful AI response.';
