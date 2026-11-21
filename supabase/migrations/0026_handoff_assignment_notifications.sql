-- Conversations + Human handoff + notifications, one workflow.
--
--  * A handoff can be ASSIGNED to a real member of the business (assigned_user_id), with who/when, and its history is kept (handoff_events).
--  * take_over_conversation / assign_handoff / resume_ai are atomic functions: row locks stop two people taking the same chat, and the
--    AI is switched off (or back on) for THAT conversation only. Resuming also clears anything still queued for the AI, so it only ever
--    answers messages that arrive after it was resumed.
--  * notifications: one row per member and event, created by database triggers (so every code path is covered), de-duplicated, and
--    persisted with a read time. The dashboard shows them in a bell, toasts and sidebar counts.
--  * conversation_reads: per person, so "unread" is correct for each member.
--  * messages.client_request_id: a double click or retry of "Send" cannot send twice.
-- All new tables are tenant-scoped, readable only by the right members, and written only by the server or by these functions.

alter table public.handoff_requests add constraint handoff_requests_id_client_key unique (id, client_id);
alter table public.handoff_requests
  add column assigned_user_id uuid references auth.users (id) on delete set null,
  add column assigned_at timestamptz,
  add column resolved_by uuid references auth.users (id) on delete set null,
  add column resumed_ai_at timestamptz;

create table public.handoff_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  handoff_id uuid not null,
  kind text not null check (kind in ('created', 'taken_over', 'assigned', 'resolved', 'resumed_ai')),
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_label text,                                  -- null = the assistant or the system
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (handoff_id, client_id) references public.handoff_requests (id, client_id) on delete cascade
);
create index handoff_events_handoff on public.handoff_events (handoff_id, created_at);
alter table public.handoff_events enable row level security;
grant select on public.handoff_events to authenticated;
create policy "members read handoff events" on public.handoff_events
  for select to authenticated using (client_id in (select public.current_client_ids()));

create function public.handoff_created_event() returns trigger language plpgsql set search_path = '' as $$
begin
  insert into public.handoff_events (client_id, handoff_id, kind, detail)
  values (new.client_id, new.id, 'created', jsonb_build_object('source', new.source));
  return new;
end;
$$;
create trigger handoff_requests_created_event after insert on public.handoff_requests for each row execute function public.handoff_created_event();

-- ------------------------------------------------------------- take over (atomic)
-- One person at a time. If the chat is already assigned to someone else it is NOT taken (out_taken = false, and who has it is returned):
-- an assignment is never silently replaced.
create function public.take_over_conversation(p_client_id uuid, p_conversation_id uuid, p_user_id uuid, p_label text default null)
returns table (out_handoff_id uuid, out_taken boolean, out_assigned_user_id uuid)
language plpgsql set search_path = '' as $$
declare h public.handoff_requests%rowtype;
begin
  perform 1 from public.client_users where client_id = p_client_id and user_id = p_user_id;
  if not found then raise exception 'not a member of this business'; end if;
  perform 1 from public.conversations where id = p_conversation_id and client_id = p_client_id for update;  -- serialises everyone acting on this chat
  if not found then raise exception 'conversation not found for this client'; end if;

  select * into h from public.handoff_requests
   where conversation_id = p_conversation_id and client_id = p_client_id and status <> 'resolved' for update;
  if found then
    if h.assigned_user_id is not null and h.assigned_user_id <> p_user_id then
      return query select h.id, false, h.assigned_user_id;
      return;
    end if;
    update public.handoff_requests
       set status = 'human_active', assigned_user_id = p_user_id, assigned_at = now(), assigned_to = null, updated_at = now()
     where id = h.id;
  else
    insert into public.handoff_requests (client_id, conversation_id, source, reason, status, assigned_user_id, assigned_at)
    values (p_client_id, p_conversation_id, 'owner', 'Taken over by the owner', 'human_active', p_user_id, now())
    returning * into h;
  end if;
  update public.conversations set handling = 'human_active', updated_at = now() where id = p_conversation_id and client_id = p_client_id;
  delete from public.pending_messages where conversation_id = p_conversation_id and client_id = p_client_id; -- nothing queued for the AI survives a takeover
  insert into public.handoff_events (client_id, handoff_id, kind, actor_user_id, actor_label) values (p_client_id, h.id, 'taken_over', p_user_id, p_label);
  return query select h.id, true, p_user_id;
end;
$$;

-- ------------------------------------------------------------- assign / unassign
create function public.assign_handoff(p_client_id uuid, p_handoff_id uuid, p_assignee uuid, p_actor uuid, p_label text default null)
returns boolean
language plpgsql set search_path = '' as $$
declare h public.handoff_requests%rowtype;
begin
  perform 1 from public.client_users where client_id = p_client_id and user_id = p_actor;
  if not found then raise exception 'not a member of this business'; end if;
  if p_assignee is not null then
    perform 1 from public.client_users where client_id = p_client_id and user_id = p_assignee;
    if not found then raise exception 'the assignee is not a member of this business'; end if;
  end if;
  select * into h from public.handoff_requests where id = p_handoff_id and client_id = p_client_id for update;
  if not found then raise exception 'handoff not found'; end if;
  if h.status = 'resolved' then raise exception 'handoff already resolved'; end if;
  update public.handoff_requests
     set assigned_user_id = p_assignee, assigned_at = case when p_assignee is null then null else now() end, assigned_to = null,
         status = case when p_assignee is null and h.status = 'assigned' then 'requested'
                       when p_assignee is not null and h.status = 'requested' then 'assigned' else h.status end,
         updated_at = now()
   where id = h.id;
  insert into public.handoff_events (client_id, handoff_id, kind, actor_user_id, actor_label, detail)
  values (p_client_id, h.id, 'assigned', p_actor, p_label, jsonb_build_object('from', h.assigned_user_id, 'to', p_assignee));
  return true;
end;
$$;

-- ------------------------------------------------------------- resume the AI
-- Ends the human assignment, resolves the handoff (who and when are recorded, the history stays), switches the AI back on for THIS chat
-- and drops anything still queued, so the AI only answers messages that arrive from now on. If someone else is handling the chat it is
-- refused (out_resumed = false).
create function public.resume_ai(p_client_id uuid, p_conversation_id uuid, p_user_id uuid, p_label text default null)
returns table (out_handoff_id uuid, out_resumed boolean)
language plpgsql set search_path = '' as $$
declare h public.handoff_requests%rowtype; v_found boolean;
begin
  perform 1 from public.client_users where client_id = p_client_id and user_id = p_user_id;
  if not found then raise exception 'not a member of this business'; end if;
  perform 1 from public.conversations where id = p_conversation_id and client_id = p_client_id for update;
  if not found then raise exception 'conversation not found for this client'; end if;

  select * into h from public.handoff_requests
   where conversation_id = p_conversation_id and client_id = p_client_id and status <> 'resolved' for update;
  v_found := found;
  if v_found and h.assigned_user_id is not null and h.assigned_user_id <> p_user_id then
    return query select h.id, false;
    return;
  end if;
  if v_found then
    update public.handoff_requests
       set status = 'resolved', resolved_at = now(), resolved_by = p_user_id, resumed_ai_at = now(), updated_at = now()
     where id = h.id;
    insert into public.handoff_events (client_id, handoff_id, kind, actor_user_id, actor_label) values (p_client_id, h.id, 'resumed_ai', p_user_id, p_label);
  end if;
  update public.conversations set handling = 'bot', failed_answer_count = 0, updated_at = now() where id = p_conversation_id and client_id = p_client_id;
  delete from public.pending_messages where conversation_id = p_conversation_id and client_id = p_client_id;
  return query select case when v_found then h.id else null::uuid end, true;
end;
$$;

revoke execute on function
  public.take_over_conversation(uuid, uuid, uuid, text), public.assign_handoff(uuid, uuid, uuid, uuid, text), public.resume_ai(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.take_over_conversation(uuid, uuid, uuid, text), public.assign_handoff(uuid, uuid, uuid, uuid, text), public.resume_ai(uuid, uuid, uuid, text)
  to service_role;

-- ------------------------------------------------------------- notifications
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,        -- one row per member who should see it
  kind text not null check (kind in ('handoff', 'message', 'appointment', 'ticket')),
  title text not null,
  body text,
  link text,                                                                 -- where it opens (always inside the dashboard)
  dedupe_key text not null,                                                  -- the same event can never notify the same person twice
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index notifications_user_recent on public.notifications (user_id, created_at desc);
create index notifications_user_unread on public.notifications (user_id) where read_at is null;
alter table public.notifications enable row level security;
grant select on public.notifications to authenticated;
create policy "people read their own notifications" on public.notifications
  for select to authenticated using (user_id = auth.uid() and client_id in (select public.current_client_ids()));

-- Notify every member of the business, or just one. p_replace: a newer event of the same kind (a new customer message in a chat you
-- are handling) refreshes the one notification and marks it unread again, instead of piling up.
create function public.notify_members(p_client_id uuid, p_kind text, p_title text, p_body text, p_link text, p_dedupe text,
                                      p_only_user uuid default null, p_replace boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_replace then
    insert into public.notifications (client_id, user_id, kind, title, body, link, dedupe_key)
    select p_client_id, cu.user_id, p_kind, p_title, p_body, p_link, p_dedupe
      from public.client_users cu where cu.client_id = p_client_id and (p_only_user is null or cu.user_id = p_only_user)
    on conflict (user_id, dedupe_key) do update set title = excluded.title, body = excluded.body, link = excluded.link, created_at = now(), read_at = null;
  else
    insert into public.notifications (client_id, user_id, kind, title, body, link, dedupe_key)
    select p_client_id, cu.user_id, p_kind, p_title, p_body, p_link, p_dedupe
      from public.client_users cu where cu.client_id = p_client_id and (p_only_user is null or cu.user_id = p_only_user)
    on conflict (user_id, dedupe_key) do nothing;
  end if;
end;
$$;
revoke execute on function public.notify_members(uuid, text, text, text, text, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.notify_members(uuid, text, text, text, text, text, uuid, boolean) to service_role;

create function public.customer_label(p_client_id uuid, p_conversation_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(c.name), ''), '+' || c.phone)
    from public.conversations v join public.contacts c on c.id = v.contact_id and c.client_id = v.client_id
   where v.id = p_conversation_id and v.client_id = p_client_id
$$;
revoke execute on function public.customer_label(uuid, uuid) from public, anon, authenticated;
grant execute on function public.customer_label(uuid, uuid) to service_role;

-- A new human handoff (not one the owner started themselves).
create function public.notify_new_handoff() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  if new.source = 'owner' then return new; end if;
  v_name := coalesce(public.customer_label(new.client_id, new.conversation_id), 'A customer');
  perform public.notify_members(new.client_id, 'handoff', 'New customer needs assistance',
    left(v_name || ': ' || coalesce(nullif(btrim(new.ai_summary), ''), nullif(btrim(new.reason), ''), 'wants to speak with a person'), 200),
    '/dashboard/conversations/' || new.conversation_id, 'handoff:' || new.id);
  return new;
end;
$$;
create trigger handoff_requests_notify after insert on public.handoff_requests for each row execute function public.notify_new_handoff();

create function public.notify_new_appointment() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify_members(new.client_id, 'appointment', 'New appointment request',
    left(coalesce(nullif(btrim(new.customer_name), ''), '+' || new.customer_phone) || ': ' || new.purpose, 200),
    '/dashboard/appointments/' || new.id, 'appointment:' || new.id);
  return new;
end;
$$;
create trigger appointments_notify after insert on public.appointments for each row execute function public.notify_new_appointment();

create function public.notify_new_ticket() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.notify_members(new.client_id, 'ticket', 'New support ticket',
    left(coalesce(nullif(btrim(new.customer_name), ''), '+' || new.customer_phone) || ': ' || new.subject, 200),
    '/dashboard/tickets/' || new.id, 'ticket:' || new.id);
  return new;
end;
$$;
create trigger tickets_notify after insert on public.tickets for each row execute function public.notify_new_ticket();

-- A new customer message in a chat that is assigned to someone: tell THAT person (one notification per chat, refreshed by each new message).
-- Messages in a chat that is merely waiting do not notify again: the handoff already did.
create function public.notify_assigned_message() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_assignee uuid;
begin
  if new.direction <> 'inbound' or new.sender <> 'customer' then return new; end if;
  select h.assigned_user_id into v_assignee from public.handoff_requests h
   where h.conversation_id = new.conversation_id and h.client_id = new.client_id and h.status in ('assigned', 'human_active') limit 1;
  if v_assignee is null then return new; end if;
  perform public.notify_members(new.client_id, 'message', 'New message from ' || coalesce(public.customer_label(new.client_id, new.conversation_id), 'a customer'),
    left(coalesce(nullif(btrim(new.body), ''), '[' || new.type || ' message]'), 140),
    '/dashboard/conversations/' || new.conversation_id, 'message:' || new.conversation_id, v_assignee, true);
  return new;
end;
$$;
create trigger messages_notify_assigned after insert on public.messages for each row execute function public.notify_assigned_message();

-- ------------------------------------------------------------- unread tracking and safe sending
create table public.conversation_reads (
  conversation_id uuid not null,
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (conversation_id, user_id),
  foreign key (conversation_id, client_id) references public.conversations (id, client_id) on delete cascade
);
alter table public.conversation_reads enable row level security;
grant select on public.conversation_reads to authenticated;
create policy "people read their own read marks" on public.conversation_reads
  for select to authenticated using (user_id = auth.uid() and client_id in (select public.current_client_ids()));

alter table public.messages add column client_request_id text;
create unique index messages_request_once on public.messages (client_id, client_request_id) where client_request_id is not null;
