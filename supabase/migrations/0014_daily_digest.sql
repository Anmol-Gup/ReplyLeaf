-- How the owner is emailed about new activity: one daily summary (the default) or each item as it happens.
--   daily      one email a day listing new contacts, leads, appointment requests and support tickets, plus what is
--              still waiting. Chats handed to a person (and the AI-key and billing emails) are urgent and stay immediate.
--   immediate  the earlier behaviour: one email per new contact, lead, appointment request and ticket.
alter table public.notification_settings
  add column delivery text not null default 'daily' check (delivery in ('daily', 'immediate')),
  add column last_digest_at timestamptz,     -- the digest covers everything after this
  add column last_digest_on date;            -- at most one digest per business per day (UTC date)

-- True only for the caller that wins today's digest, so a job that runs twice sends one email.
create function public.claim_daily_digest(p_client_id uuid, p_today date)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_row uuid;
begin
  insert into public.notification_settings (client_id) values (p_client_id) on conflict (client_id) do nothing;
  update public.notification_settings set last_digest_on = p_today, updated_at = now()
   where client_id = p_client_id and last_digest_on is distinct from p_today
  returning id into v_row;
  return v_row is not null;
end;
$$;

-- The send failed: give today's slot back so the next run can try again.
create function public.release_daily_digest(p_client_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.notification_settings set last_digest_on = null where client_id = p_client_id
$$;

create function public.mark_digest_sent(p_client_id uuid, p_at timestamptz)
returns void
language sql
set search_path = ''
as $$
  update public.notification_settings set last_digest_at = p_at where client_id = p_client_id
$$;

revoke execute on function public.claim_daily_digest(uuid, date), public.release_daily_digest(uuid), public.mark_digest_sent(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_daily_digest(uuid, date), public.release_daily_digest(uuid), public.mark_digest_sent(uuid, timestamptz)
  to service_role;
