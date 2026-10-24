-- Embedded Signup hardening: resumable onboarding, real status, token expiry,
-- one-client-per-WABA, and the account_update webhook log.

-- ------------------------------------------------------------------ clients
-- manual    = created by an admin script (no Embedded Signup)
-- pending   = our steps finished; waiting for Meta's account_update confirmation
-- connected = Meta confirmed (account_update PARTNER_ADDED)
-- failed    = a step failed or the token expired; the owner can retry
alter table public.clients
  add column onboarding_status text not null default 'manual'
    check (onboarding_status in ('manual', 'pending', 'connected', 'failed')),
  add column onboarding_step text,             -- last step reached / the step that failed
  add column onboarding_updated_at timestamptz;

-- A WABA belongs to exactly one client (phone numbers already have a unique index).
create unique index clients_wa_waba_id_key on public.clients (wa_waba_id) where wa_waba_id is not null;

-- ------------------------------------------------------------------ secrets
-- Expiry of the business token. Null for tokens we do not know the expiry of
-- (manually created clients). `assumed` = Meta's code exchange did not tell us,
-- so we assumed the 60 days configured in the portal.
alter table public.client_secrets
  add column wa_token_expires_at timestamptz,
  add column wa_token_expiry_assumed boolean not null default false;
create index client_secrets_expiry_idx on public.client_secrets (wa_token_expires_at)
  where wa_token_expires_at is not null;

-- ----------------------------------------------------- account_update events
-- Raw confirmation events from Meta. client_id is null until we can match the WABA
-- (the event can arrive BEFORE our callback has created the client).
create table public.whatsapp_account_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on delete cascade,
  waba_id text not null,
  event text not null,
  created_at timestamptz not null default now()
);
create index whatsapp_account_events_waba_idx on public.whatsapp_account_events (waba_id, event);
alter table public.whatsapp_account_events enable row level security;  -- server only: no policy, no grant

-- Record an account_update event and update the matching client in one step.
-- PARTNER_ADDED confirms onboarding (only moves 'pending' -> 'connected', it never
-- hides a failure). PARTNER_REMOVED means the customer removed our app.
create function public.apply_account_event(p_waba_id text, p_event text)
returns table (out_client_id uuid, out_status text)
language plpgsql
set search_path = ''
as $$
declare
  v_client_id uuid;
begin
  select id into v_client_id from public.clients where wa_waba_id = p_waba_id;

  insert into public.whatsapp_account_events (client_id, waba_id, event)
  values (v_client_id, p_waba_id, p_event);

  if v_client_id is not null then
    if p_event = 'PARTNER_ADDED' then
      update public.clients
         set onboarding_status = 'connected', onboarding_step = 'confirmed', onboarding_updated_at = now()
       where id = v_client_id and onboarding_status = 'pending';
    elsif p_event = 'PARTNER_REMOVED' then
      update public.clients
         set onboarding_status = 'failed', onboarding_step = 'partner_removed', onboarding_updated_at = now()
       where id = v_client_id and onboarding_status in ('pending', 'connected');
    end if;
  end if;

  return query select v_client_id, c.onboarding_status
                 from public.clients c where c.id = v_client_id;
end;
$$;

-- Retention: also delete these logs after 90 days (counted with the alerts).
create or replace function public.run_retention(p_now timestamptz default now())
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
  v_messages bigint; v_questions bigint; v_contacts bigint; v_secrets bigint; v_alerts bigint; v_events bigint;
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

  delete from public.whatsapp_account_events where created_at < p_now - interval '90 days';
  get diagnostics v_events = row_count;

  return query select v_messages, v_questions, v_contacts, v_secrets, v_alerts + v_events;
end;
$$;

revoke execute on function public.apply_account_event(text, text) from public, anon, authenticated;
grant execute on function public.apply_account_event(text, text) to service_role;
