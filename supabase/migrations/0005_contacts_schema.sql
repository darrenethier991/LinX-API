-- ============================================================
-- LinX — Migration 0005: CRM Contacts + Orgs extensions
-- Adds the contacts table and extends teams/users for CRM use.
-- All Worker CRM endpoints (api.js) write to these tables.
-- ============================================================

-- ============================================================
-- contacts
-- ============================================================

create table if not exists public.contacts (
  id          uuid        primary key default gen_random_uuid(),
  email       text        not null,
  name        text,
  phone       text,
  org_id      uuid        references public.teams(id) on delete set null,
  created_by  uuid        references public.users(id) on delete set null,

  -- CRM enrichment fields
  source      text        not null default 'api'
                check (source in ('api','sms','web','manual','import')),
  tags        text[]      not null default '{}',
  notes       text,
  lead_score  integer     check (lead_score between 1 and 10),

  -- Flexible metadata blob (intent, sms_sid, entities, etc.)
  meta        jsonb       not null default '{}',

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Unique email per org (nulls are excluded from uniqueness check)
create unique index if not exists idx_contacts_email_org
  on public.contacts(email, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid));

comment on table  public.contacts               is 'CRM contacts. Created via api.js or SMS intake pipeline.';
comment on column public.contacts.source        is 'Origin of the contact: api | sms | web | manual | import';
comment on column public.contacts.tags          is 'Free-form string tags for filtering/segmentation';
comment on column public.contacts.lead_score    is 'AI-generated score 1-10 from qualify_lead agent';
comment on column public.contacts.meta          is 'Arbitrary KV data: sms_sid, intent, entities, lead_tier, etc.';

-- ============================================================
-- RLS for contacts
-- ============================================================

alter table public.contacts enable row level security;

-- Users can see contacts belonging to their org (or their own if no org)
create policy contacts_select_member on public.contacts
  for select
  using (
    public.is_admin() or
    (org_id is not null and org_id = public.my_team_id()) or
    (org_id is null   and created_by = auth.uid())
  );

-- Inserts only via service role (api.js uses SUPABASE_SERVICE_KEY)
-- Browser cannot insert contacts directly

-- Updates only by org members or admin
create policy contacts_update_member on public.contacts
  for update
  using (
    public.is_admin() or
    (org_id is not null and org_id = public.my_team_id()) or
    created_by = auth.uid()
  );

-- ============================================================
-- Indexes
-- ============================================================

create index if not exists idx_contacts_org_id
  on public.contacts(org_id)
  where org_id is not null;

create index if not exists idx_contacts_phone
  on public.contacts(phone)
  where phone is not null;

create index if not exists idx_contacts_source
  on public.contacts(source);

create index if not exists idx_contacts_lead_score
  on public.contacts(lead_score desc)
  where lead_score is not null;

create index if not exists idx_contacts_created_at
  on public.contacts(created_at desc);

-- GIN index for tag array filtering
create index if not exists idx_contacts_tags
  on public.contacts using gin(tags);

-- GIN index for meta JSONB queries
create index if not exists idx_contacts_meta
  on public.contacts using gin(meta);

-- ============================================================
-- updated_at trigger
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists contacts_set_updated_at on public.contacts;
create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute procedure public.set_updated_at();

-- ============================================================
-- upsert_contact RPC
-- Called by api.js handleCreateContact and sms.js CRM forward.
-- Upserts on (email, org_id) — updates enrichment fields if exists.
-- ============================================================

create or replace function public.upsert_contact(
  p_email       text,
  p_name        text        default null,
  p_phone       text        default null,
  p_org_id      uuid        default null,
  p_source      text        default 'api',
  p_tags        text[]      default '{}',
  p_notes       text        default null,
  p_lead_score  integer     default null,
  p_meta        jsonb       default '{}',
  p_created_by  uuid        default null
)
returns public.contacts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.contacts;
begin
  insert into public.contacts
    (email, name, phone, org_id, source, tags, notes, lead_score, meta, created_by)
  values
    (p_email, p_name, p_phone, p_org_id, p_source,
     coalesce(p_tags, '{}'), p_notes, p_lead_score,
     coalesce(p_meta, '{}'), p_created_by)
  on conflict (email, coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set
    name        = coalesce(excluded.name,       contacts.name),
    phone       = coalesce(excluded.phone,      contacts.phone),
    source      = excluded.source,
    tags        = (select array(select distinct unnest(contacts.tags || excluded.tags))),
    notes       = coalesce(excluded.notes,      contacts.notes),
    lead_score  = coalesce(excluded.lead_score, contacts.lead_score),
    meta        = contacts.meta || excluded.meta,  -- merge, not replace
    updated_at  = now()
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.upsert_contact is
  'Upserts a contact by (email, org_id). Merges tags and meta on conflict. Called by api.js + sms.js.';
