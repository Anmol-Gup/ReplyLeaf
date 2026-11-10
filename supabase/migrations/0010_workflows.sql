-- Appointment requests, project enquiries (leads), notification settings and per-business workflow settings.
-- Everything is tenant-scoped (client_id + composite foreign keys) with RLS: owners can READ their own rows;
-- all writes go through the dashboard's server code or the assistant's server code (service role).

-- ---- per-business settings and per-conversation workflow state ----
alter table public.clients add column workflow_settings jsonb not null default '{}';   -- validated in code (lib/workflow-settings.ts)
alter table public.conversations add column workflow_state jsonb;                       -- {flow, stage, updatedAt} while the assistant is collecting details

-- A handoff can now also start when saving a request fails.
alter table public.handoff_requests drop constraint handoff_requests_source_check;
alter table public.handoff_requests add constraint handoff_requests_source_check
  check (source in ('customer_request', 'failed_answers', 'booking_without_link', 'owner', 'action_failed'));

-- ---- appointments ----
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  conversation_id uuid not null,
  contact_id uuid not null,
  customer_name text,
  customer_phone text not null,
  purpose text not null,
  preferred_date date,
  preferred_time text,
  timezone text,
  appointment_type text check (appointment_type in ('online', 'in_person')),
  notes text,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'reschedule_requested', 'rejected', 'cancelled', 'completed')),
  scheduled_date date,            -- what the owner confirmed (may differ from the preference)
  scheduled_time text,
  reschedule_note text,           -- the alternative the owner proposed; shown to the customer
  internal_notes text,            -- never shown to customers
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, client_id) references public.conversations (id, client_id) on delete cascade,
  foreign key (contact_id, client_id) references public.contacts (id, client_id) on delete cascade
);
-- One OPEN request per conversation: a retried webhook or a repeated "yes" cannot create a duplicate (or a duplicate email).
create unique index appointments_one_open_per_conversation
  on public.appointments (conversation_id) where status in ('pending', 'reschedule_requested');
create index appointments_client_status on public.appointments (client_id, status, created_at desc);
create index appointments_client_scheduled on public.appointments (client_id, scheduled_date);

alter table public.appointments enable row level security;
create policy "members read appointments" on public.appointments
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- out_created is true only for the call that created the row: that is when the owner is emailed.
create function public.create_appointment(
  p_client_id uuid, p_conversation_id uuid, p_contact_id uuid,
  p_customer_name text, p_customer_phone text, p_purpose text,
  p_preferred_date date, p_preferred_time text, p_timezone text, p_appointment_type text, p_notes text
)
returns table (out_id uuid, out_created boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform 1 from public.conversations where id = p_conversation_id and client_id = p_client_id and contact_id = p_contact_id;
  if not found then raise exception 'conversation not found for this client'; end if;

  insert into public.appointments (client_id, conversation_id, contact_id, customer_name, customer_phone, purpose,
                                   preferred_date, preferred_time, timezone, appointment_type, notes)
  values (p_client_id, p_conversation_id, p_contact_id, p_customer_name, p_customer_phone, p_purpose,
          p_preferred_date, p_preferred_time, p_timezone, p_appointment_type, p_notes)
  on conflict (conversation_id) where status in ('pending', 'reschedule_requested') do nothing
  returning id into v_id;

  if v_id is not null then
    out_id := v_id; out_created := true;
  else
    select a.id into out_id from public.appointments a
     where a.conversation_id = p_conversation_id and a.status in ('pending', 'reschedule_requested');
    out_created := false;
  end if;
  return next;
end;
$$;

-- Move an appointment along. Allowed moves (anything else raises):
--   confirm      pending | reschedule_requested -> confirmed   (sets the scheduled date/time)
--   reject       pending | reschedule_requested -> rejected
--   reschedule   pending | confirmed            -> reschedule_requested (stores the alternative)
--   cancel       pending | confirmed | reschedule_requested -> cancelled
--   complete     confirmed                      -> completed
create function public.set_appointment_status(
  p_client_id uuid, p_appointment_id uuid, p_action text,
  p_date date default null, p_time text default null, p_note text default null
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  a public.appointments%rowtype;
  v_new text;
begin
  select * into a from public.appointments where id = p_appointment_id and client_id = p_client_id for update;
  if not found then raise exception 'appointment not found'; end if;

  if p_action = 'confirm' then
    if a.status not in ('pending', 'reschedule_requested') then raise exception 'cannot confirm from %', a.status; end if;
    v_new := 'confirmed';
    update public.appointments
       set status = v_new, scheduled_date = coalesce(p_date, a.preferred_date), scheduled_time = coalesce(nullif(btrim(p_time), ''), a.preferred_time),
           reschedule_note = null, updated_at = now()
     where id = a.id;
  elsif p_action = 'reject' then
    if a.status not in ('pending', 'reschedule_requested') then raise exception 'cannot reject from %', a.status; end if;
    v_new := 'rejected';
    update public.appointments set status = v_new, reschedule_note = nullif(btrim(p_note), ''), updated_at = now() where id = a.id;
  elsif p_action = 'reschedule' then
    if a.status not in ('pending', 'confirmed') then raise exception 'cannot reschedule from %', a.status; end if;
    if p_note is null or length(btrim(p_note)) = 0 then raise exception 'an alternative date or time is required'; end if;
    v_new := 'reschedule_requested';
    update public.appointments set status = v_new, reschedule_note = btrim(p_note), updated_at = now() where id = a.id;
  elsif p_action = 'cancel' then
    if a.status not in ('pending', 'confirmed', 'reschedule_requested') then raise exception 'cannot cancel from %', a.status; end if;
    v_new := 'cancelled';
    update public.appointments set status = v_new, updated_at = now() where id = a.id;
  elsif p_action = 'complete' then
    if a.status <> 'confirmed' then raise exception 'only a confirmed appointment can be completed'; end if;
    v_new := 'completed';
    update public.appointments set status = v_new, updated_at = now() where id = a.id;
  else
    raise exception 'unknown action';
  end if;
  return v_new;
end;
$$;

-- ---- leads (project enquiries) ----
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  conversation_id uuid not null,
  contact_id uuid not null,
  customer_name text,
  customer_phone text not null,
  project_type text not null,
  description text not null,
  budget text,
  timeline text,
  status text not null default 'new'
    check (status in ('new', 'qualified', 'contacted', 'proposal_sent', 'negotiation', 'won', 'lost')),
  ai_summary text,
  internal_notes text,
  follow_up_at date,
  dedupe_key text not null,       -- hash of project type + description: the same enquiry sent twice is stored once
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, client_id) references public.conversations (id, client_id) on delete cascade,
  foreign key (contact_id, client_id) references public.contacts (id, client_id) on delete cascade,
  unique (client_id, conversation_id, dedupe_key),
  unique (id, client_id)
);
create index leads_client_status on public.leads (client_id, status, created_at desc);
create index leads_client_followup on public.leads (client_id, follow_up_at) where follow_up_at is not null;

alter table public.leads enable row level security;
create policy "members read leads" on public.leads
  for select to authenticated using (client_id in (select public.current_client_ids()));

create table public.lead_requirements (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null,
  client_id uuid not null references public.clients (id) on delete cascade,
  requirement_key text not null,
  requirement_value text not null,
  created_at timestamptz not null default now(),
  foreign key (lead_id, client_id) references public.leads (id, client_id) on delete cascade
);
create index lead_requirements_lead on public.lead_requirements (lead_id);

alter table public.lead_requirements enable row level security;
create policy "members read lead requirements" on public.lead_requirements
  for select to authenticated using (client_id in (select public.current_client_ids()));

create function public.create_lead(
  p_client_id uuid, p_conversation_id uuid, p_contact_id uuid,
  p_customer_name text, p_customer_phone text, p_project_type text, p_description text,
  p_budget text, p_timeline text, p_status text, p_ai_summary text, p_dedupe_key text, p_requirements jsonb
)
returns table (out_id uuid, out_created boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform 1 from public.conversations where id = p_conversation_id and client_id = p_client_id and contact_id = p_contact_id;
  if not found then raise exception 'conversation not found for this client'; end if;

  insert into public.leads (client_id, conversation_id, contact_id, customer_name, customer_phone, project_type, description,
                            budget, timeline, status, ai_summary, dedupe_key)
  values (p_client_id, p_conversation_id, p_contact_id, p_customer_name, p_customer_phone, p_project_type, p_description,
          p_budget, p_timeline, p_status, p_ai_summary, p_dedupe_key)
  on conflict (client_id, conversation_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    select l.id into out_id from public.leads l
     where l.client_id = p_client_id and l.conversation_id = p_conversation_id and l.dedupe_key = p_dedupe_key;
    out_created := false;
    return next;
    return;
  end if;

  insert into public.lead_requirements (lead_id, client_id, requirement_key, requirement_value)
  select v_id, p_client_id, r->>'key', r->>'value'
    from jsonb_array_elements(coalesce(p_requirements, '[]'::jsonb)) r
   where coalesce(r->>'key', '') <> '' and coalesce(r->>'value', '') <> '';

  out_id := v_id; out_created := true;
  return next;
end;
$$;

-- ---- notification settings (one row per business) ----
create table public.notification_settings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients (id) on delete cascade,
  primary_email text,
  additional_emails text[] not null default '{}',
  appointment_notifications boolean not null default true,
  lead_notifications boolean not null default true,
  handoff_notifications boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.notification_settings enable row level security;
create policy "members read notification settings" on public.notification_settings
  for select to authenticated using (client_id in (select public.current_client_ids()));

revoke execute on function
  public.create_appointment(uuid, uuid, uuid, text, text, text, date, text, text, text, text),
  public.set_appointment_status(uuid, uuid, text, date, text, text),
  public.create_lead(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, jsonb)
from public, anon, authenticated;
grant execute on function
  public.create_appointment(uuid, uuid, uuid, text, text, text, date, text, text, text, text),
  public.set_appointment_status(uuid, uuid, text, date, text, text),
  public.create_lead(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text, jsonb)
to service_role;
