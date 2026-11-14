-- 1) A customer can now have SEVERAL open appointment requests (different purposes, same or different dates).
--    The old "one open request per conversation" index is replaced by a duplicate check: the SAME request
--    (purpose + date + time) twice while it is still open is stored once, so a retried webhook cannot double up.
-- 2) Support tickets: a customer's problem or question to raise ("my order didn't arrive"), tracked separately
--    from leads (project enquiries), appointments and handoffs. Same tenant rules: client_id on every row,
--    composite foreign keys, RLS read for members, writes only through server code (service role).

-- ---- appointments: many open requests, duplicates still blocked ----
alter table public.appointments add column dedupe_key text;
update public.appointments
   set dedupe_key = md5(lower(btrim(purpose)) || '|' || coalesce(preferred_date::text, '') || '|' || lower(coalesce(btrim(preferred_time), '')));
drop index public.appointments_one_open_per_conversation;
create unique index appointments_open_dedupe
  on public.appointments (conversation_id, dedupe_key)
  where status in ('pending', 'reschedule_requested') and dedupe_key is not null;

drop function public.create_appointment(uuid, uuid, uuid, text, text, text, date, text, text, text, text);
create function public.create_appointment(
  p_client_id uuid, p_conversation_id uuid, p_contact_id uuid,
  p_customer_name text, p_customer_phone text, p_purpose text,
  p_preferred_date date, p_preferred_time text, p_timezone text, p_appointment_type text, p_notes text,
  p_dedupe_key text
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
                                   preferred_date, preferred_time, timezone, appointment_type, notes, dedupe_key)
  values (p_client_id, p_conversation_id, p_contact_id, p_customer_name, p_customer_phone, p_purpose,
          p_preferred_date, p_preferred_time, p_timezone, p_appointment_type, p_notes, p_dedupe_key)
  on conflict (conversation_id, dedupe_key) where status in ('pending', 'reschedule_requested') and dedupe_key is not null do nothing
  returning id into v_id;

  if v_id is not null then
    out_id := v_id; out_created := true;
  else
    select a.id into out_id from public.appointments a
     where a.conversation_id = p_conversation_id and a.dedupe_key = p_dedupe_key and a.status in ('pending', 'reschedule_requested');
    out_created := false;
  end if;
  return next;
end;
$$;

-- ---- support tickets ----
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  conversation_id uuid not null,
  contact_id uuid not null,
  customer_name text,
  customer_phone text not null,
  subject text not null,
  description text not null,
  category text,                  -- free text, for example "delivery" or "billing"
  reference_info text,            -- an order or invoice number the customer gave
  priority text not null default 'normal' check (priority in ('normal', 'high')),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed')),
  ai_summary text,
  assigned_to text,               -- free text (name or email): there are no team accounts yet
  internal_notes text,            -- never shown to customers
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (conversation_id, client_id) references public.conversations (id, client_id) on delete cascade,
  foreign key (contact_id, client_id) references public.contacts (id, client_id) on delete cascade
);
-- The same open issue sent twice is stored once. After it is resolved the same problem can be raised again.
create unique index tickets_open_dedupe on public.tickets (conversation_id, dedupe_key)
  where status in ('open', 'in_progress', 'waiting_on_customer');
create index tickets_client_status on public.tickets (client_id, status, created_at desc);
create index tickets_contact on public.tickets (contact_id);

alter table public.tickets enable row level security;
create policy "members read tickets" on public.tickets
  for select to authenticated using (client_id in (select public.current_client_ids()));

create function public.create_ticket(
  p_client_id uuid, p_conversation_id uuid, p_contact_id uuid,
  p_customer_name text, p_customer_phone text, p_subject text, p_description text,
  p_category text, p_reference_info text, p_priority text, p_ai_summary text, p_dedupe_key text
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

  insert into public.tickets (client_id, conversation_id, contact_id, customer_name, customer_phone, subject, description,
                              category, reference_info, priority, ai_summary, dedupe_key)
  values (p_client_id, p_conversation_id, p_contact_id, p_customer_name, p_customer_phone, p_subject, p_description,
          p_category, p_reference_info, p_priority, p_ai_summary, p_dedupe_key)
  on conflict (conversation_id, dedupe_key) where status in ('open', 'in_progress', 'waiting_on_customer') do nothing
  returning id into v_id;

  if v_id is not null then
    out_id := v_id; out_created := true;
  else
    select t.id into out_id from public.tickets t
     where t.conversation_id = p_conversation_id and t.dedupe_key = p_dedupe_key and t.status in ('open', 'in_progress', 'waiting_on_customer');
    out_created := false;
  end if;
  return next;
end;
$$;

alter table public.notification_settings add column ticket_notifications boolean not null default true;

revoke execute on function
  public.create_appointment(uuid, uuid, uuid, text, text, text, date, text, text, text, text, text),
  public.create_ticket(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text)
from public, anon, authenticated;
grant execute on function
  public.create_appointment(uuid, uuid, uuid, text, text, text, date, text, text, text, text, text),
  public.create_ticket(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text)
to service_role;
