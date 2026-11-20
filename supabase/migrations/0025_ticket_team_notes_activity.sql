-- Ticket assignment to a real team member, private notes over time, and an activity timeline.
--
--  * tickets.assigned_user_id: the actual user (from client_users, i.e. a member of THIS business). The old free-text assigned_to and
--    internal_notes columns are kept untouched: older tickets still show them (as "Previously assigned to" / "Earlier note").
--  * ticket_notes: any number of private notes, each with its author and time. Never shown to customers.
--  * ticket_events: what happened to a ticket and who did it. Written only by the server. NO events are invented for tickets that
--    existed before this migration: their timeline starts empty and fills as things happen.
-- All three are tenant-scoped (composite foreign keys), readable by the business's own members only, and written only by server code.

alter table public.tickets add constraint tickets_id_client_key unique (id, client_id);
alter table public.tickets add column assigned_user_id uuid references auth.users (id) on delete set null;

create table public.ticket_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  ticket_id uuid not null,
  author_user_id uuid references auth.users (id) on delete set null,
  author_label text,                               -- who wrote it, kept even if the account is later removed
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (ticket_id, client_id) references public.tickets (id, client_id) on delete cascade
);
create index ticket_notes_ticket on public.ticket_notes (ticket_id, created_at);
alter table public.ticket_notes enable row level security;
grant select on public.ticket_notes to authenticated;
create policy "members read ticket notes" on public.ticket_notes
  for select to authenticated using (client_id in (select public.current_client_ids()));

create table public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  ticket_id uuid not null,
  kind text not null check (kind in ('created', 'status', 'priority', 'category', 'assigned', 'note', 'notification', 'resolved', 'closed')),
  detail jsonb not null default '{}'::jsonb,       -- small facts only (old and new value, channel, message id). Never note text.
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_label text,                                -- null means the assistant or the system
  created_at timestamptz not null default now(),
  foreign key (ticket_id, client_id) references public.tickets (id, client_id) on delete cascade
);
create index ticket_events_ticket on public.ticket_events (ticket_id, created_at);
alter table public.ticket_events enable row level security;
grant select on public.ticket_events to authenticated;
create policy "members read ticket events" on public.ticket_events
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- A newly created ticket records its own "created" event (the assistant did it). Same function as before plus that one insert.
create or replace function public.create_ticket(
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
    insert into public.ticket_events (client_id, ticket_id, kind, detail)
    values (p_client_id, v_id, 'created', jsonb_build_object('priority', p_priority, 'category', p_category));
    out_id := v_id; out_created := true;
  else
    select t.id into out_id from public.tickets t
     where t.conversation_id = p_conversation_id and t.dedupe_key = p_dedupe_key and t.status in ('open', 'in_progress', 'waiting_on_customer');
    out_created := false;
  end if;
  return next;
end;
$$;
revoke execute on function public.create_ticket(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_ticket(uuid, uuid, uuid, text, text, text, text, text, text, text, text, text) to service_role;
