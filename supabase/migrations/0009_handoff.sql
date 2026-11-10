-- Human handoff: a record per handoff (why, AI summary, who has it, notes) next to the existing
-- conversations.handling switch. `handling` stays the ONLY thing that silences the assistant
-- ('bot' = assistant replies, 'human_active' = silent), so batching and webhooks are unchanged.
-- The richer status lives here:  requested -> assigned -> human_active -> resolved.

create table public.handoff_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  conversation_id uuid not null,
  source text not null check (source in ('customer_request', 'failed_answers', 'booking_without_link', 'owner')),
  reason text,                    -- plain-language reason shown to the owner
  ai_summary text,                -- short summary of what the customer needs (model-written, length-limited in code)
  status text not null default 'requested' check (status in ('requested', 'assigned', 'human_active', 'resolved')),
  assigned_to text,               -- free text (name or email): there are no team accounts yet
  internal_notes text,            -- never shown to customers
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (conversation_id, client_id) references public.conversations (id, client_id) on delete cascade
);

-- One OPEN handoff per conversation: a webhook retry (or a second trigger) cannot create a duplicate
-- request or a duplicate email.
create unique index handoff_one_open_per_conversation
  on public.handoff_requests (conversation_id) where status <> 'resolved';
create index handoff_requests_client_status
  on public.handoff_requests (client_id, status, created_at desc);

alter table public.handoff_requests enable row level security;
create policy "members read handoff requests" on public.handoff_requests
  for select to authenticated using (client_id in (select public.current_client_ids()));
-- No insert/update/delete policy: owners change handoffs only through the dashboard's server code
-- (service role), which checks their membership first.

-- Open a handoff (or return the one already open) and silence the assistant for THAT conversation only.
-- out_created is true only for the call that created the row: that is when the owner is emailed.
create function public.create_handoff(
  p_client_id uuid,
  p_conversation_id uuid,
  p_source text,
  p_reason text,
  p_summary text,
  p_status text default 'requested',
  p_assigned_to text default null
)
returns table (out_id uuid, out_created boolean)
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform 1 from public.conversations where id = p_conversation_id and client_id = p_client_id;
  if not found then
    raise exception 'conversation not found for this client';
  end if;

  insert into public.handoff_requests (client_id, conversation_id, source, reason, ai_summary, status, assigned_to)
  values (p_client_id, p_conversation_id, p_source, p_reason, p_summary, p_status, p_assigned_to)
  on conflict (conversation_id) where status <> 'resolved' do nothing
  returning id into v_id;

  if v_id is not null then
    out_id := v_id; out_created := true;
  else
    select h.id into out_id from public.handoff_requests h
     where h.conversation_id = p_conversation_id and h.status <> 'resolved';
    out_created := false;
    -- A later trigger may bring a better summary for the same open request.
    update public.handoff_requests set ai_summary = p_summary, updated_at = now()
     where id = out_id and ai_summary is null and p_summary is not null;
  end if;

  update public.conversations set handling = 'human_active', updated_at = now()
   where id = p_conversation_id and client_id = p_client_id;
  return next;
end;
$$;

-- Move a handoff along. Allowed moves (anything else raises):
--   assign     requested | assigned | human_active -> (requested->assigned; others keep their status), sets assigned_to
--   take_over  requested | assigned                -> human_active (assigned_to optional)
--   resolve    any open status                     -> resolved (the assistant STAYS silent until resumed)
--   resume_ai  any open status                     -> resolved and the assistant is switched back on
create function public.set_handoff_status(
  p_client_id uuid,
  p_handoff_id uuid,
  p_action text,
  p_assignee text default null
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  h public.handoff_requests%rowtype;
  v_new text;
begin
  select * into h from public.handoff_requests
   where id = p_handoff_id and client_id = p_client_id for update;
  if not found then
    raise exception 'handoff not found';
  end if;
  if h.status = 'resolved' then
    raise exception 'handoff already resolved';
  end if;

  if p_action = 'assign' then
    if p_assignee is null or length(btrim(p_assignee)) = 0 then raise exception 'assignee required'; end if;
    v_new := case when h.status = 'requested' then 'assigned' else h.status end;
    update public.handoff_requests set status = v_new, assigned_to = btrim(p_assignee), updated_at = now() where id = h.id;
  elsif p_action = 'take_over' then
    if h.status not in ('requested', 'assigned') then raise exception 'already taken over'; end if;
    v_new := 'human_active';
    update public.handoff_requests
       set status = v_new, assigned_to = coalesce(nullif(btrim(p_assignee), ''), assigned_to), updated_at = now()
     where id = h.id;
  elsif p_action = 'resolve' then
    v_new := 'resolved';
    update public.handoff_requests set status = v_new, resolved_at = now(), updated_at = now() where id = h.id;
  elsif p_action = 'resume_ai' then
    v_new := 'resolved';
    update public.handoff_requests set status = v_new, resolved_at = now(), updated_at = now() where id = h.id;
    update public.conversations set handling = 'bot', failed_answer_count = 0, updated_at = now()
     where id = h.conversation_id and client_id = p_client_id;
  else
    raise exception 'unknown action';
  end if;
  return v_new;
end;
$$;

revoke execute on function
  public.create_handoff(uuid, uuid, text, text, text, text, text),
  public.set_handoff_status(uuid, uuid, text, text)
from public, anon, authenticated;
grant execute on function
  public.create_handoff(uuid, uuid, text, text, text, text, text),
  public.set_handoff_status(uuid, uuid, text, text)
to service_role;

-- Conversations that were already handled by a person before this migration get a handoff record,
-- so the new Human Handoff page shows them.
insert into public.handoff_requests (client_id, conversation_id, source, reason, status)
select c.client_id, c.id, 'owner', 'Taken over by the owner', 'human_active'
  from public.conversations c
 where c.handling = 'human_active'
on conflict (conversation_id) where status <> 'resolved' do nothing;
