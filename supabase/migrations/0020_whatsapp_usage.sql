-- WhatsApp messaging usage and billing awareness. Extends the existing messages table (no second table).
--
-- messages already holds every message, with sender (customer / bot = AI / human = owner or agent), status and wa_message_id
-- (unique, so a retried delivery or a duplicate status webhook cannot create a second row). New columns:
--   wa_category      service | marketing | utility | authentication | unknown. Decided by how the message was SENT (free-form text is a
--                    service message; a template carries its own category), never guessed from the text.
--   via              api = sent through Replyleaf (AI replies, dashboard replies); business_app = typed by the owner in the WhatsApp
--                    Business app (coexistence echoes). Only api messages are counted: Replyleaf did not send the others.
--   phone_number_id  which business number sent it (filled automatically), so usage is counted per phone number.
--   delivered_at     when WhatsApp first reported delivery. Usage counts delivered messages only.
--   error_code       Meta's error code on a failed delivery.
alter table public.messages
  add column wa_category text not null default 'service' check (wa_category in ('service', 'marketing', 'utility', 'authentication', 'unknown')),
  add column via text not null default 'api' check (via in ('api', 'business_app')),
  add column phone_number_id text,
  add column delivered_at timestamptz,
  add column error_code integer;

-- Per business: what Meta charges is its own business, but WHETHER this number gets the free allowance is not always known.
-- 'unknown' is the honest default; the owner can say eligible or not_eligible. The billing notice acknowledgement is recorded when
-- a number is connected through Embedded Signup.
alter table public.clients
  add column wa_free_allowance text not null default 'unknown' check (wa_free_allowance in ('eligible', 'not_eligible', 'unknown')),
  add column wa_billing_ack_at timestamptz,
  add column last_webhook_at timestamptz;

-- Every outbound message records which number sent it, without touching every insert site.
create function public.messages_fill_phone_number() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.direction = 'outbound' and new.phone_number_id is null then
    select c.wa_phone_number_id into new.phone_number_id from public.clients c where c.id = new.client_id;
  end if;
  return new;
end;
$$;
create trigger messages_fill_phone_number before insert on public.messages for each row execute function public.messages_fill_phone_number();

-- Existing rows: the number they were sent from is the business's current number; delivery time is approximated by when we stored them.
update public.messages m set phone_number_id = c.wa_phone_number_id
  from public.clients c where m.client_id = c.id and m.direction = 'outbound' and m.phone_number_id is null;
update public.messages set delivered_at = created_at where status in ('delivered', 'read') and delivered_at is null;

create index messages_usage_idx on public.messages (client_id, phone_number_id, created_at) where direction = 'outbound';

-- Owner replies typed in the WhatsApp Business app are not sent through Replyleaf: record them as such.
create or replace function public.record_owner_echo(
  p_client_id uuid, p_phone text, p_wa_message_id text, p_type text, p_body text, p_sent_at timestamptz
)
returns table (out_duplicate boolean, out_conversation_id uuid)
language plpgsql set search_path = '' as $$
declare
  v_contact_id uuid; v_conversation_id uuid; v_message_id uuid; v_handling text;
begin
  insert into public.contacts (client_id, phone) values (p_client_id, p_phone)
  on conflict (client_id, phone) do update set phone = excluded.phone returning id into v_contact_id;
  insert into public.conversations (client_id, contact_id) values (p_client_id, v_contact_id)
  on conflict (client_id, contact_id) do update set updated_at = now() returning id into v_conversation_id;
  insert into public.messages (client_id, conversation_id, direction, sender, via, type, body, wa_message_id, wa_timestamp, status)
  values (p_client_id, v_conversation_id, 'outbound', 'human', 'business_app', p_type, p_body, p_wa_message_id, p_sent_at, 'sent')
  on conflict (wa_message_id) do nothing returning id into v_message_id;
  if v_message_id is not null then
    select handling into v_handling from public.conversations where id = v_conversation_id and client_id = p_client_id;
    if v_handling = 'bot' then
      perform public.create_handoff(p_client_id, v_conversation_id, 'owner',
        'You replied from the WhatsApp Business app, so the assistant stepped aside for this chat.', null, 'human_active', null);
    end if;
  end if;
  out_duplicate := v_message_id is null; out_conversation_id := v_conversation_id;
  return next;
end;
$$;

-- Apply a delivery status from Meta's webhook. Idempotent and safe against out-of-order or duplicate webhooks:
--   sent -> delivered -> read only moves forward; a delivered or read message is never turned into failed or back to sent;
--   a failed message stays failed; delivered_at is set once.
-- Returns true only if the row changed.
create function public.apply_message_status(
  p_wa_message_id text, p_status text, p_error text, p_error_code integer, p_at timestamptz
)
returns boolean
language plpgsql set search_path = '' as $$
declare cur text;
begin
  select status into cur from public.messages where wa_message_id = p_wa_message_id and direction = 'outbound' for update;
  if not found then return false; end if;
  if cur = 'read' or cur = 'failed' then return false; end if;
  if cur = 'delivered' and p_status <> 'read' then return false; end if;
  if p_status = 'sent' and cur is not null and cur <> 'sent' then return false; end if;
  update public.messages
     set status = p_status,
         delivered_at = case when p_status in ('delivered', 'read') then coalesce(delivered_at, p_at, now()) else delivered_at end,
         error = case when p_status = 'failed' then p_error else error end,
         error_code = case when p_status = 'failed' then p_error_code else error_code end
   where wa_message_id = p_wa_message_id and direction = 'outbound';
  return true;
end;
$$;
revoke execute on function public.apply_message_status(text, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.apply_message_status(text, text, text, integer, timestamptz) to service_role;

-- Per phone number and category, for one business and one period: how many outbound messages were delivered, failed, or are still
-- waiting for a delivery update. Counts ONLY messages sent through Replyleaf (via = api), never 'blocked' ones (never sent).
-- security invoker: the caller's row level security applies, so an owner can only ever see their own business.
create function public.wa_usage_summary(p_client_id uuid, p_since timestamptz, p_until timestamptz)
returns table (out_phone_number_id text, out_category text, out_total bigint, out_delivered bigint, out_failed bigint, out_awaiting bigint)
language sql stable security invoker set search_path = '' as $$
  select m.phone_number_id, m.wa_category,
         count(*),
         count(*) filter (where m.status in ('delivered', 'read')),
         count(*) filter (where m.status = 'failed'),
         count(*) filter (where m.status = 'sent' or m.status is null)
    from public.messages m
   where m.client_id = p_client_id and m.direction = 'outbound' and m.via = 'api' and coalesce(m.status, 'sent') <> 'blocked'
     and coalesce(m.delivered_at, m.created_at) >= p_since and coalesce(m.delivered_at, m.created_at) < p_until
   group by m.phone_number_id, m.wa_category
$$;
grant execute on function public.wa_usage_summary(uuid, timestamptz, timestamptz) to authenticated, service_role;
