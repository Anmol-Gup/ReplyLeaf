-- Atomically store one inbound WhatsApp message.
--  * upserts the contact and the conversation
--  * inserts the message; the UNIQUE wa_message_id makes Meta retries a no-op
--  * moves last_customer_message_at forward (never backwards)
-- Two concurrent deliveries of the same wamid: the second insert waits on the
-- unique index, then does nothing and reports duplicate = true.
create function public.record_inbound_message(
  p_client_id uuid,
  p_phone text,
  p_profile_name text,
  p_wa_message_id text,
  p_type text,
  p_body text,
  p_sent_at timestamptz
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
begin
  -- The WhatsApp profile name is only used to seed a brand-new contact.
  insert into public.contacts (client_id, phone, name)
  values (p_client_id, p_phone, p_profile_name)
  on conflict (client_id, phone) do update set phone = excluded.phone
  returning id into v_contact_id;

  insert into public.conversations (client_id, contact_id)
  values (p_client_id, v_contact_id)
  on conflict (client_id, contact_id) do update set updated_at = now()
  returning id into v_conversation_id;

  insert into public.messages (client_id, conversation_id, direction, sender, type, body, wa_message_id, wa_timestamp)
  values (p_client_id, v_conversation_id, 'inbound', 'customer', p_type, p_body, p_wa_message_id, p_sent_at)
  on conflict (wa_message_id) do nothing
  returning id into v_message_id;

  if v_message_id is not null then
    update public.conversations c
       set last_customer_message_at = greatest(coalesce(c.last_customer_message_at, p_sent_at), p_sent_at),
           updated_at = now()
     where c.id = v_conversation_id and c.client_id = p_client_id;
  end if;

  return query
    select v_message_id is null, c.id, c.handling, c.last_customer_message_at
      from public.conversations c
     where c.id = v_conversation_id and c.client_id = p_client_id;
end;
$$;

-- Server only: never callable with an owner's or anonymous JWT.
revoke execute on function public.record_inbound_message(uuid, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_inbound_message(uuid, text, text, text, text, text, timestamptz)
  to service_role;
