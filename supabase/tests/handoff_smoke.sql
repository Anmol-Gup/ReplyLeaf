-- Smoke test for human handoff (migration 0009): lifecycle, duplicate delivery, tenant isolation, RLS.
-- A plain SQL script (no pgTAP). Run it against a THROWAWAY Postgres that has migrations 0001-0009 applied
-- and Supabase's roles stubbed (anon, authenticated, service_role, auth.users, auth.uid()). Never run it on
-- a real project: it inserts fixture rows (inside a transaction that is rolled back at the end).
-- Every check prints "ok - ..." and the script stops at the first failure.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','a@x.com'),('00000000-0000-0000-0000-0000000000b1','b@x.com');
insert into public.clients (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001','A'),('bbbbbbbb-0000-0000-0000-000000000001','B');
insert into public.client_users (client_id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1'),('bbbbbbbb-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1');
insert into public.contacts (id, client_id, phone) values
 ('aaaaaaaa-0000-0000-0000-0000000000c1','aaaaaaaa-0000-0000-0000-000000000001','111'),
 ('aaaaaaaa-0000-0000-0000-0000000000c2','aaaaaaaa-0000-0000-0000-000000000001','112'),
 ('bbbbbbbb-0000-0000-0000-0000000000c1','bbbbbbbb-0000-0000-0000-000000000001','222');
insert into public.conversations (id, client_id, contact_id) values
 ('aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1'),
 ('aaaaaaaa-0000-0000-0000-0000000000d2','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c2'),
 ('bbbbbbbb-0000-0000-0000-0000000000d1','bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000c1');

create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
create function pg_temp.fails(sql text, msg text) returns void language plpgsql as $$ begin begin execute sql; exception when others then raise notice 'ok - % (%)', msg, sqlerrm; return; end; raise exception 'FAILED (no error): %', msg; end $$;

-- 1. create: row made, only THIS conversation silenced
select pg_temp.check((select out_created from public.create_handoff('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','customer_request','why','sum')), 'first create_handoff reports created');
select pg_temp.check((select handling from public.conversations where id='aaaaaaaa-0000-0000-0000-0000000000d1')='human_active', 'that conversation is silenced');
select pg_temp.check((select handling from public.conversations where id='aaaaaaaa-0000-0000-0000-0000000000d2')='bot', 'the same business''s other conversation stays on the assistant');
select pg_temp.check((select handling from public.conversations where id='bbbbbbbb-0000-0000-0000-0000000000d1')='bot', 'another business is untouched');
-- 2. retry: no duplicate, not created
select pg_temp.check(not (select out_created from public.create_handoff('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','customer_request','why','sum2')), 'duplicate delivery returns created=false');
select pg_temp.check((select count(*) from public.handoff_requests where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1')=1, 'still exactly one open handoff');
-- 3. another business cannot create a handoff on this conversation
select pg_temp.fails($$select * from public.create_handoff('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','owner','x',null)$$, 'create_handoff for a foreign conversation is rejected');
-- 4. lifecycle
select pg_temp.check(public.set_handoff_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.handoff_requests where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1'),'assign','Priya')='assigned', 'assign: requested -> assigned');
select pg_temp.check(public.set_handoff_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.handoff_requests where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1'),'take_over','me@x.com')='human_active', 'take_over -> human_active');
select pg_temp.fails($$select public.set_handoff_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.handoff_requests where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1'),'take_over',null)$$, 'second take_over is rejected');
-- 5. another business cannot change it
select pg_temp.fails($$select public.set_handoff_status('bbbbbbbb-0000-0000-0000-000000000001',(select id from public.handoff_requests where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1'),'resolve',null)$$, 'foreign business cannot resolve my handoff');
-- 6. resolve keeps the assistant silent; resume_ai on a fresh handoff switches it back
select pg_temp.check(public.set_handoff_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.handoff_requests where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1'),'resolve',null)='resolved', 'resolve');
select pg_temp.check((select handling from public.conversations where id='aaaaaaaa-0000-0000-0000-0000000000d1')='human_active', 'resolve leaves the assistant paused');
select pg_temp.fails($$select public.set_handoff_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.handoff_requests where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1'),'resume_ai',null)$$, 'a resolved handoff cannot be changed');
select pg_temp.check((select out_created from public.create_handoff('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','failed_answers','again',null)), 'after resolving, a new handoff can be opened');
select pg_temp.check(public.set_handoff_status('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.handoff_requests where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1' and status<>'resolved'),'resume_ai',null)='resolved', 'resume_ai');
select pg_temp.check((select handling from public.conversations where id='aaaaaaaa-0000-0000-0000-0000000000d1')='bot', 'resume_ai switches the assistant back on');
select pg_temp.fails($$select public.set_handoff_status('aaaaaaaa-0000-0000-0000-000000000001',gen_random_uuid(),'bogus',null)$$, 'unknown handoff id is rejected');
select pg_temp.fails($$insert into public.handoff_requests (client_id, conversation_id, source) values ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','owner')$$, 'composite FK blocks a handoff pointing at another business''s conversation');

-- 7. RLS: owner A sees only A's handoffs; B sees none of A's; nobody can write directly
insert into public.handoff_requests (client_id, conversation_id, source) values ('bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000d1','owner');
grant select, insert, update, delete on public.handoff_requests to authenticated;  -- table privileges as Supabase grants by default; RLS must still hold
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
select pg_temp.check((select count(*) from public.handoff_requests)=2 and (select count(*) from public.handoff_requests where client_id='aaaaaaaa-0000-0000-0000-000000000001')=2, 'owner A sees only business A handoffs');
with u as (update public.handoff_requests set internal_notes='hacked' returning 1) select pg_temp.check((select count(*) from u)=0, 'owner cannot update directly (RLS: zero rows touched)');
with d as (delete from public.handoff_requests returning 1) select pg_temp.check((select count(*) from d)=0, 'owner cannot delete directly (RLS: zero rows touched)');
select pg_temp.fails($$insert into public.handoff_requests (client_id, conversation_id, source) values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d2','owner')$$, 'owner cannot insert directly (RLS)');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
select pg_temp.check((select count(*) from public.handoff_requests)=1 and (select count(*) from public.handoff_requests where client_id='bbbbbbbb-0000-0000-0000-000000000001')=1, 'owner B sees only business B handoffs');
select pg_temp.fails($$select * from public.create_handoff('bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000d1','owner','x',null)$$, 'authenticated users cannot call create_handoff (service role only)');
rollback;
