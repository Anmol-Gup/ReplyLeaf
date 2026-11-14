-- Stripe subscription billing: one plan (WhatsApp AI Assistant, 999 INR / month) per business.
-- Stripe is the source of truth. Webhooks (and a daily reconciliation job) copy its state here; the app never
-- trusts a browser redirect or a client-supplied status. Money amounts are Stripe's smallest unit (paise).
-- Tenant rules as everywhere else: client_id on every row, RLS read for the owner, writes only from server code.

-- Businesses that existed before billing was introduced keep working without a subscription ("grandfathered").
-- New businesses start without it. An admin can flip this flag for a business at any time.
alter table public.clients add column billing_exempt boolean not null default false;
update public.clients set billing_exempt = true;

-- ---- the subscription: ONE row per business (the current subscription; history lives in billing_audit + invoices) ----
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null unique references public.clients (id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_price_id text,
  status text not null default 'none'
    check (status in ('none', 'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  cancel_at timestamptz,
  canceled_at timestamptz,
  ended_at timestamptz,
  grace_ends_at timestamptz,            -- set once when a renewal first fails: 7 days to fix payment
  last_payment_failed_at timestamptz,
  checkout_session_id text,             -- the last Checkout Session we created (reused while it is still open)
  checkout_created_at timestamptz,
  synced_at timestamptz,                -- when this state was last confirmed with Stripe (older snapshots are ignored)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_status on public.subscriptions (status);
create index subscriptions_period_end on public.subscriptions (current_period_end);

alter table public.subscriptions enable row level security;
create policy "members read subscription" on public.subscriptions
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- ---- invoices: the payment history shown on the billing page ----
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  stripe_invoice_id text not null unique,
  stripe_subscription_id text,
  status text not null,                 -- Stripe's: draft, open, paid, uncollectible, void
  billing_reason text,
  amount_due bigint not null default 0,
  amount_paid bigint not null default 0,
  currency text not null default 'inr',
  attempt_count integer not null default 0,
  hosted_invoice_url text,
  invoice_pdf text,
  period_start timestamptz,
  period_end timestamptz,
  paid_at timestamptz,
  source_event_created bigint not null default 0,   -- the Stripe event time this row reflects (older events never overwrite it)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index invoices_client_created on public.invoices (client_id, created_at desc);

alter table public.invoices enable row level security;
create policy "members read invoices" on public.invoices
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- ---- webhook idempotency: every Stripe event id is processed once ----
create table public.stripe_events (
  event_id text primary key,
  type text not null,
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed', 'ignored')),
  attempts integer not null default 1,
  error text,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;   -- no policy: server only

-- ---- audit trail of subscription changes (never holds secrets) ----
create table public.billing_audit (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  event text not null,
  detail jsonb not null default '{}',
  stripe_event_id text,
  created_at timestamptz not null default now()
);
create index billing_audit_client on public.billing_audit (client_id, created_at desc);
alter table public.billing_audit enable row level security;   -- no policy: server only

-- ---- billing emails: each one is sent once, however many times Stripe repeats the event ----
create table public.billing_emails (
  client_id uuid not null references public.clients (id) on delete cascade,
  dedupe_key text not null,
  sent_at timestamptz not null default now(),
  primary key (client_id, dedupe_key)
);
alter table public.billing_emails enable row level security;  -- no policy: server only

-- ======================= functions (server only) =======================

-- Claim a webhook event. 'new' = process it; 'retry' = an earlier attempt failed (or stalled), process again;
-- 'duplicate' = already processed, ignored, or being processed right now.
create function public.claim_stripe_event(p_event_id text, p_type text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
  v_updated timestamptz;
begin
  insert into public.stripe_events (event_id, type) values (p_event_id, p_type)
  on conflict (event_id) do nothing;
  if found then return 'new'; end if;

  select status, updated_at into v_status, v_updated from public.stripe_events where event_id = p_event_id for update;
  if v_status in ('processed', 'ignored') then return 'duplicate'; end if;
  if v_status = 'processing' and v_updated > now() - interval '5 minutes' then return 'duplicate'; end if;  -- in flight elsewhere
  update public.stripe_events set status = 'processing', attempts = attempts + 1, updated_at = now() where event_id = p_event_id;
  return 'retry';
end;
$$;

create function public.finish_stripe_event(p_event_id text, p_status text, p_error text default null)
returns void
language sql
set search_path = ''
as $$
  update public.stripe_events set status = p_status, error = left(p_error, 500), updated_at = now() where event_id = p_event_id
$$;

-- Apply a snapshot of the subscription as Stripe reports it. Safe against stale and out-of-order data:
--  * a snapshot observed BEFORE the last one we applied is ignored;
--  * a different (older, ended) subscription cannot overwrite a live one;
--  * the grace period starts once, on the first failure, and is cleared when the subscription is healthy again.
create function public.apply_subscription_snapshot(
  p_client_id uuid,
  p_customer_id text,
  p_subscription_id text,
  p_price_id text,
  p_status text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_cancel_at timestamptz,
  p_canceled_at timestamptz,
  p_ended_at timestamptz,
  p_observed_at timestamptz,
  p_grace_start timestamptz default null,
  p_grace_days integer default 7
)
returns table (out_applied boolean, out_reason text, out_prev_status text, out_status text, out_grace_ends_at timestamptz)
language plpgsql
set search_path = ''
as $$
declare
  s public.subscriptions%rowtype;
  v_live constant text[] := array['active', 'trialing', 'past_due', 'incomplete'];
  v_grace timestamptz;
begin
  insert into public.subscriptions (client_id) values (p_client_id) on conflict (client_id) do nothing;
  select * into s from public.subscriptions where client_id = p_client_id for update;
  out_prev_status := s.status;

  if s.synced_at is not null and p_observed_at < s.synced_at then
    out_applied := false; out_reason := 'stale'; out_status := s.status; out_grace_ends_at := s.grace_ends_at;
    return next; return;
  end if;

  if s.stripe_subscription_id is not null and s.stripe_subscription_id <> p_subscription_id then
    -- Another subscription id than the one we track. An old, ended one must never overwrite a live one.
    if s.status = any (v_live) and p_status <> all (v_live) then
      out_applied := false; out_reason := 'older_subscription'; out_status := s.status; out_grace_ends_at := s.grace_ends_at;
      return next; return;
    end if;
    if s.status = any (v_live) and p_status = any (v_live) then
      out_applied := false; out_reason := 'duplicate_subscription'; out_status := s.status; out_grace_ends_at := s.grace_ends_at;
      return next; return;
    end if;
  end if;

  v_grace := s.grace_ends_at;
  if p_status = 'past_due' then
    v_grace := coalesce(s.grace_ends_at, coalesce(p_grace_start, p_observed_at) + make_interval(days => p_grace_days));
  elsif p_status in ('active', 'trialing') then
    v_grace := null;
  end if;

  update public.subscriptions set
    stripe_customer_id = coalesce(p_customer_id, stripe_customer_id),
    stripe_subscription_id = p_subscription_id,
    stripe_price_id = coalesce(p_price_id, stripe_price_id),
    status = p_status,
    current_period_start = p_period_start,
    current_period_end = p_period_end,
    cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
    cancel_at = p_cancel_at,
    canceled_at = p_canceled_at,
    ended_at = p_ended_at,
    grace_ends_at = v_grace,
    last_payment_failed_at = case when p_status = 'past_due' then coalesce(p_grace_start, last_payment_failed_at) else last_payment_failed_at end,
    synced_at = p_observed_at,
    updated_at = now()
  where client_id = p_client_id;

  if s.status is distinct from p_status then
    insert into public.billing_audit (client_id, event, detail)
    values (p_client_id, 'status_changed', jsonb_build_object('from', s.status, 'to', p_status, 'subscription', p_subscription_id));
  end if;

  out_applied := true; out_reason := 'applied'; out_status := p_status; out_grace_ends_at := v_grace;
  return next;
end;
$$;

-- Store (or update) an invoice. An older event never overwrites a newer one.
create function public.upsert_invoice(
  p_client_id uuid, p_invoice_id text, p_subscription_id text, p_status text, p_billing_reason text,
  p_amount_due bigint, p_amount_paid bigint, p_currency text, p_attempt_count integer,
  p_hosted_url text, p_pdf text, p_period_start timestamptz, p_period_end timestamptz, p_paid_at timestamptz,
  p_event_created bigint
)
returns void
language sql
set search_path = ''
as $$
  insert into public.invoices (client_id, stripe_invoice_id, stripe_subscription_id, status, billing_reason, amount_due, amount_paid,
                               currency, attempt_count, hosted_invoice_url, invoice_pdf, period_start, period_end, paid_at, source_event_created)
  values (p_client_id, p_invoice_id, p_subscription_id, p_status, p_billing_reason, p_amount_due, p_amount_paid,
          lower(p_currency), p_attempt_count, p_hosted_url, p_pdf, p_period_start, p_period_end, p_paid_at, p_event_created)
  on conflict (stripe_invoice_id) do update set
    status = excluded.status, billing_reason = coalesce(excluded.billing_reason, public.invoices.billing_reason),
    amount_due = excluded.amount_due, amount_paid = excluded.amount_paid, attempt_count = excluded.attempt_count,
    hosted_invoice_url = coalesce(excluded.hosted_invoice_url, public.invoices.hosted_invoice_url),
    invoice_pdf = coalesce(excluded.invoice_pdf, public.invoices.invoice_pdf),
    period_start = coalesce(excluded.period_start, public.invoices.period_start),
    period_end = coalesce(excluded.period_end, public.invoices.period_end),
    paid_at = coalesce(excluded.paid_at, public.invoices.paid_at),
    source_event_created = excluded.source_event_created, updated_at = now()
  where excluded.source_event_created >= public.invoices.source_event_created
$$;

-- Remember the Stripe customer and the Checkout Session we created for this business.
create function public.record_checkout(p_client_id uuid, p_customer_id text, p_session_id text)
returns void
language sql
set search_path = ''
as $$
  insert into public.subscriptions (client_id, stripe_customer_id, checkout_session_id, checkout_created_at)
  values (p_client_id, p_customer_id, p_session_id, case when p_session_id is null then null else now() end)
  on conflict (client_id) do update set
    stripe_customer_id = coalesce(excluded.stripe_customer_id, public.subscriptions.stripe_customer_id),
    checkout_session_id = coalesce(excluded.checkout_session_id, public.subscriptions.checkout_session_id),
    checkout_created_at = case when excluded.checkout_session_id is null then public.subscriptions.checkout_created_at else now() end,
    updated_at = now()
$$;

-- True only for the caller that claims this email, so a repeated webhook never sends it twice.
create function public.claim_billing_email(p_client_id uuid, p_key text)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  insert into public.billing_emails (client_id, dedupe_key) values (p_client_id, p_key) on conflict do nothing;
  return found;
end;
$$;

create function public.release_billing_email(p_client_id uuid, p_key text)
returns void
language sql
set search_path = ''
as $$
  delete from public.billing_emails where client_id = p_client_id and dedupe_key = p_key
$$;

create function public.write_billing_audit(p_client_id uuid, p_event text, p_detail jsonb, p_stripe_event_id text default null)
returns void
language sql
set search_path = ''
as $$
  insert into public.billing_audit (client_id, event, detail, stripe_event_id) values (p_client_id, p_event, coalesce(p_detail, '{}'), p_stripe_event_id)
$$;

revoke execute on function
  public.claim_stripe_event(text, text),
  public.finish_stripe_event(text, text, text),
  public.apply_subscription_snapshot(uuid, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, integer),
  public.upsert_invoice(uuid, text, text, text, text, bigint, bigint, text, integer, text, text, timestamptz, timestamptz, timestamptz, bigint),
  public.record_checkout(uuid, text, text),
  public.claim_billing_email(uuid, text),
  public.release_billing_email(uuid, text),
  public.write_billing_audit(uuid, text, jsonb, text)
from public, anon, authenticated;
grant execute on function
  public.claim_stripe_event(text, text),
  public.finish_stripe_event(text, text, text),
  public.apply_subscription_snapshot(uuid, text, text, text, text, timestamptz, timestamptz, boolean, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz, integer),
  public.upsert_invoice(uuid, text, text, text, text, bigint, bigint, text, integer, text, text, timestamptz, timestamptz, timestamptz, bigint),
  public.record_checkout(uuid, text, text),
  public.claim_billing_email(uuid, text),
  public.release_billing_email(uuid, text),
  public.write_billing_audit(uuid, text, jsonb, text)
to service_role;
