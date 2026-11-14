-- Smoke test for Stripe billing (migration 0013): webhook idempotency, stale and out-of-order snapshots, the grace
-- period, invoices, one-email-once, and tenant isolation. A plain SQL script (no pgTAP). Run it against a THROWAWAY
-- Postgres that has migrations 0001-0013 applied and Supabase's roles stubbed (anon, authenticated, service_role,
-- auth.users, auth.uid()). Never run it on a real project: it inserts fixture rows (rolled back at the end).
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','a@x.com'),('00000000-0000-0000-0000-0000000000b1','b@x.com');
insert into public.clients (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001','A'),('bbbbbbbb-0000-0000-0000-000000000001','B');
insert into public.client_users (client_id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1'),('bbbbbbbb-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1');

create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
create function pg_temp.fails(sql text, msg text) returns void language plpgsql as $$ begin begin execute sql; exception when others then raise notice 'ok - % (%)', msg, sqlerrm; return; end; raise exception 'FAILED (no error): %', msg; end $$;
create function pg_temp.snap(p_client uuid, p_sub text, p_status text, p_observed timestamptz, p_end timestamptz default '2026-12-14 00:00+00', p_cancel boolean default false, p_grace_start timestamptz default null)
returns public.subscriptions language plpgsql as $$
declare r record; s public.subscriptions;
begin
  select * into r from public.apply_subscription_snapshot(p_client, 'cus_1', p_sub, 'price_1', p_status, '2026-11-14 00:00+00', p_end, p_cancel, null, null, null, p_observed, p_grace_start);
  select * into s from public.subscriptions where client_id = p_client;
  return s;
end $$;

select pg_temp.check((select billing_exempt from public.clients where id='aaaaaaaa-0000-0000-0000-000000000001')=false, 'businesses created after the migration are NOT exempt (only the ones that existed before it were)');

-- webhook idempotency
select pg_temp.check(public.claim_stripe_event('evt_1','invoice.paid')='new', 'first delivery is new');
select pg_temp.check(public.claim_stripe_event('evt_1','invoice.paid')='duplicate', 'the same event while it is being processed is a duplicate');
select public.finish_stripe_event('evt_1','processed');
select pg_temp.check(public.claim_stripe_event('evt_1','invoice.paid')='duplicate', 'a processed event is a duplicate');
select pg_temp.check(public.claim_stripe_event('evt_2','invoice.payment_failed')='new', 'another event is new');
select public.finish_stripe_event('evt_2','failed','boom');
select pg_temp.check(public.claim_stripe_event('evt_2','invoice.payment_failed')='retry', 'a failed event can be retried');
update public.stripe_events set updated_at = now() - interval '10 minutes' where event_id='evt_2';
select pg_temp.check(public.claim_stripe_event('evt_2','invoice.payment_failed')='retry', 'a stalled "processing" event can be retried');
select public.finish_stripe_event('evt_3','ignored');
select pg_temp.check((select count(*) from public.stripe_events)=2, 'one row per event id');

-- subscription snapshots
select pg_temp.check((pg_temp.snap('aaaaaaaa-0000-0000-0000-000000000001','sub_1','active','2026-11-14 10:00+00')).status='active', 'first snapshot creates the row as active');
select pg_temp.check((select stripe_subscription_id from public.subscriptions where client_id='aaaaaaaa-0000-0000-0000-000000000001')='sub_1', 'the subscription id is stored (and unique)');
select pg_temp.check((select count(*) from public.billing_audit where client_id='aaaaaaaa-0000-0000-0000-000000000001' and event='status_changed')=1, 'a status change is written to the audit trail');
-- a STALE snapshot (observed earlier) must not overwrite a newer one
select pg_temp.check((pg_temp.snap('aaaaaaaa-0000-0000-0000-000000000001','sub_1','past_due','2026-11-14 09:00+00')).status='active', 'an older snapshot is ignored (out-of-order events)');
-- renewal fails: past_due, grace starts ONCE
select pg_temp.check((pg_temp.snap('aaaaaaaa-0000-0000-0000-000000000001','sub_1','past_due','2026-12-14 10:05+00','2026-12-14 00:00+00',false,'2026-12-14 10:00+00')).grace_ends_at='2026-12-21 10:00+00', 'grace period = 7 days from the FIRST failure');
select pg_temp.check((pg_temp.snap('aaaaaaaa-0000-0000-0000-000000000001','sub_1','past_due','2026-12-16 10:05+00','2026-12-14 00:00+00',false,'2026-12-16 10:00+00')).grace_ends_at='2026-12-21 10:00+00', 'a later retry failure does NOT extend the grace period');
-- paid during grace: active again, grace cleared
select pg_temp.check((select grace_ends_at is null and status='active' from pg_temp.snap('aaaaaaaa-0000-0000-0000-000000000001','sub_1','active','2026-12-17 10:00+00','2027-01-14 00:00+00')), 'payment recovery: active and the grace period is cleared');
-- cancel at period end keeps the paid-through date
select pg_temp.check((select cancel_at_period_end and current_period_end='2027-01-14 00:00+00' from pg_temp.snap('aaaaaaaa-0000-0000-0000-000000000001','sub_1','active','2026-12-18 10:00+00','2027-01-14 00:00+00',true)), 'cancel at period end is stored with the paid-through date');
-- an OLD ended subscription cannot overwrite the live one; a second live one is refused
select pg_temp.check((select out_reason from public.apply_subscription_snapshot('aaaaaaaa-0000-0000-0000-000000000001','cus_1','sub_OLD','price_1','canceled','2026-01-01 00:00+00','2026-02-01 00:00+00',false,null,null,'2026-02-01 00:00+00','2026-12-19 00:00+00'))='older_subscription', 'an older, ended subscription cannot overwrite the live one');
select pg_temp.check((select out_reason from public.apply_subscription_snapshot('aaaaaaaa-0000-0000-0000-000000000001','cus_1','sub_2','price_1','active','2026-12-01 00:00+00','2027-01-01 00:00+00',false,null,null,null,'2026-12-19 00:00+00'))='duplicate_subscription', 'a second LIVE subscription for one business is refused');
select pg_temp.check((select stripe_subscription_id from public.subscriptions where client_id='aaaaaaaa-0000-0000-0000-000000000001')='sub_1', 'the original subscription is untouched');
-- cancelled, then a NEW subscription replaces it (history kept in the audit trail, row not deleted)
select pg_temp.snap('aaaaaaaa-0000-0000-0000-000000000001','sub_1','canceled','2027-01-15 00:00+00');
select pg_temp.check((select stripe_subscription_id from pg_temp.snap('aaaaaaaa-0000-0000-0000-000000000001','sub_3','active','2027-02-01 00:00+00','2027-03-01 00:00+00'))='sub_3', 'after cancelling, a new subscription is accepted');
select pg_temp.check((select count(*) from public.subscriptions where client_id='aaaaaaaa-0000-0000-0000-000000000001')=1, 'still ONE subscription row per business');
select pg_temp.check((select count(*) from public.billing_audit where client_id='aaaaaaaa-0000-0000-0000-000000000001')>=4, 'the history stays in the audit trail');
select pg_temp.fails($$insert into public.subscriptions (client_id, stripe_subscription_id) values ('bbbbbbbb-0000-0000-0000-000000000001','sub_3')$$, 'a Stripe subscription id can belong to only one business');
select pg_temp.fails($$update public.subscriptions set status='gold'$$, 'status is restricted to Stripe''s states');

-- invoices: an older event never overwrites a newer one
select public.upsert_invoice('aaaaaaaa-0000-0000-0000-000000000001','in_1','sub_3','paid','subscription_cycle',99900,99900,'INR',1,'https://x','https://pdf','2026-11-14 00:00+00','2026-12-14 00:00+00','2026-11-14 00:01+00',200);
select public.upsert_invoice('aaaaaaaa-0000-0000-0000-000000000001','in_1','sub_3','open','subscription_cycle',99900,0,'INR',1,null,null,null,null,null,100);
select pg_temp.check((select status='paid' and amount_paid=99900 and currency='inr' from public.invoices where stripe_invoice_id='in_1'), 'an older invoice event does not downgrade a paid invoice');
select public.upsert_invoice('aaaaaaaa-0000-0000-0000-000000000001','in_1','sub_3','paid','subscription_cycle',99900,99900,'INR',2,null,null,null,null,null,300);
select pg_temp.check((select count(*) from public.invoices)=1 and (select attempt_count from public.invoices)=2, 'a newer event updates it, still one row (and keeps the hosted link)');
select pg_temp.check((select hosted_invoice_url from public.invoices)='https://x', 'details already known are kept when a later event omits them');

-- checkout bookkeeping + one email once
select public.record_checkout('bbbbbbbb-0000-0000-0000-000000000001','cus_b','cs_1');
select pg_temp.check((select stripe_customer_id='cus_b' and checkout_session_id='cs_1' and status='none' from public.subscriptions where client_id='bbbbbbbb-0000-0000-0000-000000000001'), 'checkout is recorded without granting anything (status stays none)');
select pg_temp.check(public.claim_billing_email('aaaaaaaa-0000-0000-0000-000000000001','failed:in_9'), 'first claim of an email wins');
select pg_temp.check(not public.claim_billing_email('aaaaaaaa-0000-0000-0000-000000000001','failed:in_9'), 'a repeat is refused: no duplicate email');
select public.release_billing_email('aaaaaaaa-0000-0000-0000-000000000001','failed:in_9');
select pg_temp.check(public.claim_billing_email('aaaaaaaa-0000-0000-0000-000000000001','failed:in_9'), 'a released claim (send failed) can be claimed again');
select public.write_billing_audit('aaaaaaaa-0000-0000-0000-000000000001','test','{"a":1}'::jsonb,'evt_9');

-- tenant isolation + no direct writes + server-only functions
grant select, insert, update, delete on public.subscriptions, public.invoices, public.stripe_events, public.billing_audit, public.billing_emails to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
select pg_temp.check((select count(*) from public.subscriptions)=1 and (select stripe_subscription_id from public.subscriptions)='sub_3', 'owner A sees only A''s subscription');
select pg_temp.check((select count(*) from public.invoices)=1, 'owner A sees only A''s invoices');
select pg_temp.check((select count(*) from public.stripe_events)=0 and (select count(*) from public.billing_audit)=0 and (select count(*) from public.billing_emails)=0, 'owners read nothing from the webhook, audit or email tables');
with u as (update public.subscriptions set status='active', current_period_end='2099-01-01' returning 1) select pg_temp.check((select count(*) from u)=0, 'an owner cannot make themselves "active" through the API');
with u as (update public.invoices set status='paid' returning 1) select pg_temp.check((select count(*) from u)=0, 'an owner cannot edit invoices');
select pg_temp.fails($$insert into public.subscriptions (client_id, status, current_period_end) values ('aaaaaaaa-0000-0000-0000-000000000001','active','2099-01-01')$$, 'an owner cannot insert a subscription');
select pg_temp.fails($$select public.apply_subscription_snapshot('aaaaaaaa-0000-0000-0000-000000000001','c','s','p','active',null,null,false,null,null,null,now())$$, 'authenticated users cannot call apply_subscription_snapshot');
select pg_temp.fails($$select public.claim_stripe_event('evt_x','t')$$, 'authenticated users cannot call claim_stripe_event');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
select pg_temp.check((select count(*) from public.subscriptions)=1 and (select stripe_customer_id from public.subscriptions)='cus_b', 'owner B sees only B''s subscription, not A''s');
select pg_temp.check((select count(*) from public.invoices)=0, 'owner B sees none of A''s invoices');
rollback;
