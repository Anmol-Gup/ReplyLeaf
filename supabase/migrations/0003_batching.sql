-- Message batching for serverless.
--
-- Customers send several short messages in a row. Each inbound message adds a
-- row to pending_messages and pushes the conversation's batch_due_at to
-- now() + 4s. After waiting, a worker CLAIMS the conversation with one atomic
-- UPDATE (the row lock means only one concurrent worker wins), replies to all
-- pending messages at once, then completes the batch.
--   batch_due_at      = when the batch may be processed (null = nothing pending)
--   batch_lease_until = set while a worker owns the batch; if the worker dies the
--                       lease expires and a sweep can re-claim it

-- Lets pending_messages point at a message of the SAME client only.
alter table public.messages
  add constraint messages_id_client_id_key unique (id, client_id);

alter table public.conversations
  add column batch_due_at timestamptz,
  add column batch_lease_until timestamptz;
create index conversations_batch_due_idx on public.conversations (batch_due_at)
  where batch_due_at is not null;

-- Server only: RLS on, no policy, no grant.
create table public.pending_messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  conversation_id uuid not null,
  message_id uuid not null unique,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, client_id) references public.conversations (id, client_id) on delete cascade,
  foreign key (message_id, client_id) references public.messages (id, client_id) on delete cascade
);
create index pending_messages_conversation_idx
  on public.pending_messages (client_id, conversation_id, created_at);
alter table public.pending_messages enable row level security;

-- record_inbound_message now also enqueues the message for batching.
-- The signature changes (new parameter), so drop the Stage 1 version.
drop function public.record_inbound_message(uuid, text, text, text, text, text, timestamptz);

create function public.record_inbound_message(
  p_client_id uuid,
  p_phone text,
  p_profile_name text,
  p_wa_message_id text,
  p_type text,
  p_body text,
  p_sent_at timestamptz,
  p_batch_delay_seconds integer default 4
)
returns table (
  out_duplicate boolean,
  out_conversation_id uuid,
  out_handling text,
  out_last_customer_message_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_handling text;
begin
  -- The WhatsApp profile name only seeds a brand-new contact.
  insert into public.contacts (client_id, phone, name)
  values (p_client_id, p_phone, p_profile_name)
  on conflict (client_id, phone) do update set phone = excluded.phone
  returning id into v_contact_id;

  insert into public.conversations (client_id, contact_id)
  values (p_client_id, v_contact_id)
  on conflict (client_id, contact_id) do update set updated_at = now()
  returning id into v_conversation_id;

  -- UNIQUE wa_message_id: a Meta retry inserts nothing and reports duplicate.
  insert into public.messages (client_id, conversation_id, direction, sender, type, body, wa_message_id, wa_timestamp)
  values (p_client_id, v_conversation_id, 'inbound', 'customer', p_type, p_body, p_wa_message_id, p_sent_at)
  on conflict (wa_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is not null then
    -- Window clock only moves forward; batch timer restarts only for bot-handled chats.
    update public.conversations c
       set last_customer_message_at = greatest(coalesce(c.last_customer_message_at, p_sent_at), p_sent_at),
           batch_due_at = case when c.handling = 'bot'
                               then now() + make_interval(secs => p_batch_delay_seconds)
                               else c.batch_due_at end,
           updated_at = now()
     where c.id = v_conversation_id and c.client_id = p_client_id
    returning c.handling into v_handling;

    if v_handling = 'bot' then
      insert into public.pending_messages (client_id, conversation_id, message_id)
      values (p_client_id, v_conversation_id, v_message_id);
    end if;
  end if;

  return query
    select v_message_id is null, c.id, c.handling, c.last_customer_message_at
      from public.conversations c
     where c.id = v_conversation_id and c.client_id = p_client_id;
end;
$$;

-- Claim a due batch. One atomic UPDATE: when two workers race, the second
-- waits for the row lock, re-checks the WHERE clause, sees the new lease and
-- updates nothing. Returns true only for the winner.
create function public.claim_batch(p_conversation_id uuid, p_lease_seconds integer default 120)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.conversations
     set batch_lease_until = now() + make_interval(secs => p_lease_seconds)
   where id = p_conversation_id
     and batch_due_at is not null
     and batch_due_at <= now()
     and (batch_lease_until is null or batch_lease_until < now())
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- Finish a batch: remove the handled pending rows and release the lease.
-- Returns true if more messages arrived meanwhile (their batch_due_at is
-- already set), so the caller should loop. Locking the conversation row makes
-- this safe against a message arriving at the same moment.
create function public.complete_batch(p_conversation_id uuid, p_pending_ids uuid[])
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_client_id uuid;
  v_more boolean;
begin
  select client_id into v_client_id
    from public.conversations where id = p_conversation_id for update;
  if v_client_id is null then
    return false;
  end if;

  delete from public.pending_messages
   where client_id = v_client_id and conversation_id = p_conversation_id
     and id = any (p_pending_ids);

  select exists (
    select 1 from public.pending_messages
     where client_id = v_client_id and conversation_id = p_conversation_id
  ) into v_more;

  update public.conversations
     set batch_lease_until = null,
         batch_due_at = case when v_more then batch_due_at else null end,
         updated_at = now()
   where id = p_conversation_id and client_id = v_client_id;
  return v_more;
end;
$$;

-- Batches that are overdue and not currently owned: stranded by a crashed
-- worker. Used by the sweep (runs after webhooks and from the cron route).
create function public.find_due_batches(p_limit integer default 5, p_grace_seconds integer default 15)
returns setof uuid
language sql stable
set search_path = ''
as $$
  select id from public.conversations
   where batch_due_at is not null
     and batch_due_at <= now() - make_interval(secs => p_grace_seconds)
     and (batch_lease_until is null or batch_lease_until < now())
   order by batch_due_at
   limit p_limit
$$;

-- Server only.
revoke execute on function
  public.record_inbound_message(uuid, text, text, text, text, text, timestamptz, integer),
  public.claim_batch(uuid, integer),
  public.complete_batch(uuid, uuid[]),
  public.find_due_batches(integer, integer)
from public, anon, authenticated;
grant execute on function
  public.record_inbound_message(uuid, text, text, text, text, text, timestamptz, integer),
  public.claim_batch(uuid, integer),
  public.complete_batch(uuid, uuid[]),
  public.find_due_batches(integer, integer)
to service_role;
