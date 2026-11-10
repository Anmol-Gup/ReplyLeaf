-- Smoke test for appointments, leads and notification settings (migration 0010): creation, duplicate delivery,
-- status moves, tenant isolation and RLS. A plain SQL script (no pgTAP). Run it against a THROWAWAY Postgres that has
-- migrations 0001-0010 applied and Supabase's roles stubbed (anon, authenticated, service_role, auth.users, auth.uid()).
-- Never run it on a real project: it inserts fixture rows (inside a transaction that is rolled back at the end).
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','a@x.com'),('00000000-0000-0000-0000-0000000000b1','b@x.com');
insert into public.clients (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001','A'),('bbbbbbbb-0000-0000-0000-000000000001','B');
insert into public.client_users (client_id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1'),('bbbbbbbb-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1');
insert into public.contacts (id, client_id, phone) values
 ('aaaaaaaa-0000-0000-0000-0000000000c1','aaaaaaaa-0000-0000-0000-000000000001','111'),
 ('bbbbbbbb-0000-0000-0000-0000000000c1','bbbbbbbb-0000-0000-0000-000000000001','222');
insert into public.conversations (id, client_id, contact_id) values
 ('aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1'),
 ('bbbbbbbb-0000-0000-0000-0000000000d1','bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000c1');

create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
create function pg_temp.fails(sql text, msg text) returns void language plpgsql as $$ begin begin execute sql; exception when others then raise notice 'ok - % (%)', msg, sqlerrm; return; end; raise exception 'FAILED (no error): %', msg; end $$;

-- defaults
select pg_temp.check((select workflow_settings from public.clients where id='aaaaaaaa-0000-0000-0000-000000000001')='{}'::jsonb, 'workflow_settings defaults to {} (code applies the defaults)');
select pg_temp.check((select workflow_state from public.conversations where id='aaaaaaaa-0000-0000-0000-0000000000d1') is null, 'workflow_state starts empty');

-- appointments: create + duplicate delivery
select pg_temp.check((select out_created from public.create_appointment('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','Asha','111','check-up','2026-03-01','10am',null,'online',null)), 'create_appointment reports created');
select pg_temp.check(not (select out_created from public.create_appointment('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','Asha','111','check-up','2026-03-01','10am',null,'online',null)), 'duplicate delivery returns created=false');
select pg_temp.check((select count(*) from public.appointments)=1, 'still exactly one open request');
select pg_temp.check((select status from public.appointments)='pending', 'new requests start as pending');
select pg_temp.fails($$select * from public.create_appointment('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','x','1','x',null,'10am',null,null,null)$$, 'another business cannot create an appointment on this conversation');
select pg_temp.fails($$select * from public.create_appointment('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','x','1','x',null,'10am',null,'sideways',null)$$, 'appointment_type is restricted to online / in_person');

-- status moves
select pg_temp.fails($$select public.set_appointment_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.appointments),'complete')$$, 'a pending appointment cannot be completed');
select pg_temp.fails($$select public.set_appointment_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.appointments),'reschedule')$$, 'reschedule needs an alternative');
select pg_temp.fails($$select public.set_appointment_status('bbbbbbbb-0000-0000-0000-000000000001',(select id from public.appointments),'confirm')$$, 'another business cannot confirm my appointment');
select pg_temp.check(public.set_appointment_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.appointments),'reschedule',null,null,'Friday 3pm')='reschedule_requested', 'reschedule stores the alternative');
select pg_temp.check((select reschedule_note from public.appointments)='Friday 3pm', 'the alternative is saved');
select pg_temp.check((select out_created from public.create_appointment('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','Asha','111','other','2026-03-02','2pm',null,null,null))=false, 'a reschedule-requested appointment still counts as the open one');
select pg_temp.check(public.set_appointment_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.appointments),'confirm','2026-03-05','3pm')='confirmed', 'confirm');
select pg_temp.check((select scheduled_date::text||' '||scheduled_time from public.appointments)='2026-03-05 3pm' and (select reschedule_note from public.appointments) is null, 'confirm stores the scheduled date/time and clears the alternative');
select pg_temp.check((select out_created from public.create_appointment('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','Asha','111','follow-up',null,'later',null,null,null)), 'once confirmed, the customer can open a new request');
select pg_temp.fails($$select public.set_appointment_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.appointments where purpose='check-up'),'reject')$$, 'a confirmed appointment cannot be rejected');
select pg_temp.check(public.set_appointment_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.appointments where purpose='check-up'),'complete')='completed', 'confirmed -> completed');
select pg_temp.fails($$select public.set_appointment_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.appointments where purpose='check-up'),'cancel')$$, 'a completed appointment cannot be cancelled');

-- leads
select pg_temp.check((select out_created from public.create_lead('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','Asha','111','website','A shop for candles','$3k','6 weeks','qualified','Wants a shop','k1','[{"key":"platform","value":"Shopify"},{"key":"","value":"x"}]'::jsonb)), 'create_lead reports created');
select pg_temp.check((select count(*) from public.lead_requirements)=1, 'requirements stored, empty keys dropped');
select pg_temp.check(not (select out_created from public.create_lead('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','Asha','111','website','A shop for candles','$3k','6 weeks','qualified','Wants a shop','k1','[]'::jsonb)), 'the same enquiry again returns created=false');
select pg_temp.check((select count(*) from public.leads)=1 and (select count(*) from public.lead_requirements)=1, 'no duplicate lead or requirements');
select pg_temp.check((select out_created from public.create_lead('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','Asha','111','mobile app','Booking app','','','new','Another project','k2','[]'::jsonb)), 'a different enquiry from the same customer is a new lead');
select pg_temp.fails($$select * from public.create_lead('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','x','1','x','x',null,null,'new',null,'k3','[]'::jsonb)$$, 'another business cannot create a lead on this conversation');
select pg_temp.fails($$update public.leads set status='closed'$$, 'lead status is restricted');
select pg_temp.fails($$insert into public.lead_requirements (lead_id, client_id, requirement_key, requirement_value) values ((select id from public.leads limit 1),'bbbbbbbb-0000-0000-0000-000000000001','k','v')$$, 'composite FK stops a requirement pointing at another business''s lead');

-- notification settings: one row per business
insert into public.notification_settings (client_id, primary_email) values ('aaaaaaaa-0000-0000-0000-000000000001','boss@x.com');
select pg_temp.fails($$insert into public.notification_settings (client_id) values ('aaaaaaaa-0000-0000-0000-000000000001')$$, 'only one notification row per business');
select pg_temp.check((select appointment_notifications and lead_notifications and handoff_notifications from public.notification_settings), 'all notification switches default to on');

-- handoff source added in 0010
select pg_temp.check((select out_created from public.create_handoff('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','action_failed','x',null)), 'handoff accepts the action_failed source');

-- RLS: each owner sees only their own rows; nobody writes directly; privileged functions are service-role only
insert into public.appointments (client_id, conversation_id, contact_id, customer_phone, purpose) values ('bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000d1','bbbbbbbb-0000-0000-0000-0000000000c1','222','B''s request');
select public.create_lead('bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000d1','bbbbbbbb-0000-0000-0000-0000000000c1','B','222','b project','b description','','','new',null,'kb','[{"key":"a","value":"b"}]'::jsonb);
insert into public.notification_settings (client_id, primary_email) values ('bbbbbbbb-0000-0000-0000-000000000001','b@x.com');
grant select, insert, update, delete on public.appointments, public.leads, public.lead_requirements, public.notification_settings to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
select pg_temp.check((select count(*) from public.appointments)=2 and (select count(*) from public.appointments where client_id<>'aaaaaaaa-0000-0000-0000-000000000001')=0, 'owner A sees only A''s appointments');
select pg_temp.check((select count(*) from public.leads where client_id<>'aaaaaaaa-0000-0000-0000-000000000001')=0 and (select count(*) from public.leads)=2, 'owner A sees only A''s leads');
select pg_temp.check((select count(*) from public.lead_requirements where client_id<>'aaaaaaaa-0000-0000-0000-000000000001')=0, 'owner A sees only A''s lead requirements');
select pg_temp.check((select count(*) from public.notification_settings where primary_email='b@x.com')=0, 'owner A cannot read B''s notification settings');
with u as (update public.appointments set internal_notes='hacked' returning 1) select pg_temp.check((select count(*) from u)=0, 'owner cannot update appointments directly');
with u as (update public.leads set internal_notes='hacked' returning 1) select pg_temp.check((select count(*) from u)=0, 'owner cannot update leads directly');
with u as (update public.notification_settings set primary_email='evil@x.com' returning 1) select pg_temp.check((select count(*) from u)=0, 'owner cannot update notification settings directly');
select pg_temp.fails($$insert into public.leads (client_id, conversation_id, contact_id, customer_phone, project_type, description, dedupe_key) values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','1','x','x','zz')$$, 'owner cannot insert leads directly');
select pg_temp.fails($$select * from public.create_appointment('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','x','1','x',null,'t',null,null,null)$$, 'authenticated users cannot call create_appointment');
select pg_temp.fails($$select public.set_appointment_status('aaaaaaaa-0000-0000-0000-000000000001', gen_random_uuid(), 'confirm')$$, 'authenticated users cannot call set_appointment_status');
select pg_temp.fails($$select * from public.create_lead('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','x','1','x','x',null,null,'new',null,'kz','[]'::jsonb)$$, 'authenticated users cannot call create_lead');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
select pg_temp.check((select count(*) from public.appointments)=1 and (select count(*) from public.leads)=1 and (select count(*) from public.notification_settings)=1, 'owner B sees only B''s rows');
rollback;
