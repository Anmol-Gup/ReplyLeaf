-- Coexistence: a business keeps using the WhatsApp Business app next to our assistant. Meta sends the
-- owner's own replies to us as "smb_message_echoes". This stores one as a human message and, if the
-- assistant was still handling that chat, silences it so the two never talk over each other.
-- (The owner can switch the assistant back on from the dashboard: "Resume assistant".)
--
-- Unlike record_inbound_message this never queues a batch and never touches last_customer_message_at
-- (the 24-hour window is about the CUSTOMER's last message).
create function public.record_owner_echo(
  p_client_id uuid,
  p_phone text,
  p_wa_message_id text,
  p_type text,
  p_body text,
  p_sent_at timestamptz
)
returns table (out_duplicate boolean, out_conversation_id uuid)
language plpgsql
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_handling text;
begin
  insert into public.contacts (client_id, phone)
  values (p_client_id, p_phone)
  on conflict (client_id, phone) do update set phone = excluded.phone
  returning id into v_contact_id;

  insert into public.conversations (client_id, contact_id)
  values (p_client_id, v_contact_id)
  on conflict (client_id, contact_id) do update set updated_at = now()
  returning id into v_conversation_id;

  insert into public.messages (client_id, conversation_id, direction, sender, type, body, wa_message_id, wa_timestamp, status)
  values (p_client_id, v_conversation_id, 'outbound', 'human', p_type, p_body, p_wa_message_id, p_sent_at, 'sent')
  on conflict (wa_message_id) do nothing
  returning id into v_message_id;

  -- A duplicate delivery (Meta retry) changes nothing.
  if v_message_id is not null then
    select handling into v_handling from public.conversations where id = v_conversation_id and client_id = p_client_id;
    if v_handling = 'bot' then
      perform public.create_handoff(p_client_id, v_conversation_id, 'owner',
        'You replied from the WhatsApp Business app, so the assistant stepped aside for this chat.', null, 'human_active', null);
    end if;
  end if;

  out_duplicate := v_message_id is null;
  out_conversation_id := v_conversation_id;
  return next;
end;
$$;

revoke execute on function public.record_owner_echo(uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_owner_echo(uuid, text, text, text, text, timestamptz) to service_role;
