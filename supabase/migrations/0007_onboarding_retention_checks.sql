-- Stage 6: onboarding secrets, retention job, daily reply check.

-- Two-step-verification PIN chosen when we register a customer's number
-- (Embedded Signup step). Encrypted like the token; kept so an admin can re-register.
alter table public.client_secrets add column wa_pin_enc text;

create index messages_created_at_idx on public.messages (created_at) where body is not null;

-- ------------------------------------------------------------ retention job
-- Policy:
--   * message CONTENT deleted after 12 months (the row stays, for counts/usage)
--   * unanswered-question text deleted after 12 months (it is customer wording)
--   * contacts (and, by cascade, their conversations, messages, bookings) deleted
--     12 months after the client left
--   * a departed client's WhatsApp token is wiped immediately
--   * logs (admin_alerts) deleted after 90 days
-- Database BACKUPS (90 days) are managed by Supabase, not by this function.
create function public.run_retention(p_now timestamptz default now())
returns table (
  out_messages_blanked bigint,
  out_questions_deleted bigint,
  out_contacts_deleted bigint,
  out_secrets_wiped bigint,
  out_alerts_deleted bigint
)
language plpgsql
set search_path = ''
as $$
declare
  v_messages bigint; v_questions bigint; v_contacts bigint; v_secrets bigint; v_alerts bigint;
begin
  update public.messages set body = null
   where body is not null and created_at < p_now - interval '12 months';
  get diagnostics v_messages = row_count;

  delete from public.unanswered_questions where created_at < p_now - interval '12 months';
  get diagnostics v_questions = row_count;

  delete from public.client_secrets
   where client_id in (select id from public.clients where status = 'left');
  get diagnostics v_secrets = row_count;

  delete from public.contacts
   where client_id in (
     select id from public.clients where status = 'left' and left_at < p_now - interval '12 months'
   );
  get diagnostics v_contacts = row_count;

  delete from public.admin_alerts where created_at < p_now - interval '90 days';
  get diagnostics v_alerts = row_count;

  return query select v_messages, v_questions, v_contacts, v_secrets, v_alerts;
end;
$$;

-- ------------------------------------------------------------- daily check
-- Per active client over the window: messages received vs replies sent, plus
-- signs that something silently broke:
--   unreplied    = bot-handled conversations whose customer message (older than
--                  the grace period) never got any reply
--   failed       = outbound messages that failed or were blocked
--   stuck        = batches overdue by more than the grace period
create function public.daily_reply_check(p_since timestamptz, p_grace_minutes integer default 15)
returns table (
  out_client_id uuid,
  out_client_name text,
  out_received bigint,
  out_replied bigint,
  out_unreplied bigint,
  out_failed bigint,
  out_stuck bigint
)
language sql stable
set search_path = ''
as $$
  select c.id, c.name,
    (select count(*) from public.messages m
      where m.client_id = c.id and m.direction = 'inbound' and m.created_at >= p_since),
    (select count(*) from public.messages m
      where m.client_id = c.id and m.direction = 'outbound'
        and m.status in ('sent', 'delivered', 'read') and m.created_at >= p_since),
    (select count(*) from public.conversations v
      where v.client_id = c.id and v.handling = 'bot'
        and exists (
          select 1 from public.messages i
           where i.client_id = c.id and i.conversation_id = v.id and i.direction = 'inbound'
             and i.created_at >= p_since
             and i.created_at <= now() - make_interval(mins => p_grace_minutes)
             and not exists (
               select 1 from public.messages o
                where o.client_id = c.id and o.conversation_id = v.id
                  and o.direction = 'outbound' and o.created_at >= i.created_at))),
    (select count(*) from public.messages m
      where m.client_id = c.id and m.direction = 'outbound'
        and m.status in ('failed', 'blocked') and m.created_at >= p_since),
    (select count(*) from public.conversations v
      where v.client_id = c.id and v.batch_due_at is not null
        and v.batch_due_at <= now() - make_interval(mins => p_grace_minutes))
  from public.clients c
  where c.status = 'active'
  order by c.name
$$;

-- Server only.
revoke execute on function public.run_retention(timestamptz), public.daily_reply_check(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.run_retention(timestamptz), public.daily_reply_check(timestamptz, integer)
  to service_role;
