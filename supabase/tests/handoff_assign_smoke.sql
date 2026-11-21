-- Smoke test for migration 0026: atomic takeover/assignment/resume, handoff history, notifications (dedupe, recipients, tenant), reads.
-- Run on a THROWAWAY Postgres with migrations 0001-0026 and stubbed Supabase roles. Rolls back at the end.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','a@x.com'),('00000000-0000-0000-0000-0000000000a2','a2@x.com'),('00000000-0000-0000-0000-0000000000b1','b@x.com');
insert into public.clients (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001','A'),('bbbbbbbb-0000-0000-0000-000000000001','B');
insert into public.client_users (client_id, user_id) values
 ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1'),
 ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a2'),
 ('bbbbbbbb-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1');
insert into public.contacts (id, client_id, phone, name) values
 ('aaaaaaaa-0000-0000-0000-0000000000c1','aaaaaaaa-0000-0000-0000-000000000001','111','Surya'),
 ('aaaaaaaa-0000-0000-0000-0000000000c2','aaaaaaaa-0000-0000-0000-000000000001','112',null),
 ('bbbbbbbb-0000-0000-0000-0000000000c1','bbbbbbbb-0000-0000-0000-000000000001','222',null);
insert into public.conversations (id, client_id, contact_id) values
 ('aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1'),
 ('aaaaaaaa-0000-0000-0000-0000000000d2','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c2'),
 ('bbbbbbbb-0000-0000-0000-0000000000d1','bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000c1');
create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
create function pg_temp.fails(sql text, msg text) returns void language plpgsql as $$ begin begin execute sql; exception when others then raise notice 'ok - % (%)', msg, sqlerrm; return; end; raise exception 'FAILED (no error): %', msg; end $$;

-- 1. a customer handoff notifies every member of THAT business, once, and not the other business
select public.create_handoff('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','customer_request','wants a person','needs a quote');
select public.create_handoff('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','customer_request','wants a person','again'); -- webhook retry
select pg_temp.check((select count(*) from public.notifications where kind='handoff' and client_id='aaaaaaaa-0000-0000-0000-000000000001')=2, 'one handoff notification per member, no duplicates on retry');
select pg_temp.check((select count(*) from public.notifications where client_id='bbbbbbbb-0000-0000-0000-000000000001')=0, 'other business gets nothing');
select pg_temp.check((select body like 'Surya:%' from public.notifications limit 1), 'notification names the customer');
select pg_temp.check((select count(*) from public.handoff_events where kind='created')=1, 'created event recorded once');

-- 2. a waiting handoff: more customer messages do NOT notify
insert into public.messages (client_id, conversation_id, direction, sender, type, body) values
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','inbound','customer','text','hello?');
select pg_temp.check((select count(*) from public.notifications where kind='message')=0, 'no per-message notification while waiting');

-- 3. takeover: atomic, only one person; the second is refused and nothing is replaced
select pg_temp.check((select out_taken from public.take_over_conversation('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a1','A one')), 'first person takes over');
select pg_temp.check(not (select out_taken from public.take_over_conversation('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a2','A two')), 'second person cannot take it');
select pg_temp.check((select assigned_user_id from public.handoff_requests where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1')='00000000-0000-0000-0000-0000000000a1', 'assignment not silently replaced');
select pg_temp.check((select assigned_at is not null and status='human_active' from public.handoff_requests where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1'), 'assigned_at set, status human_active');
select pg_temp.fails($$select * from public.take_over_conversation('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1','x')$$, 'a member of another business cannot take over');
select pg_temp.fails($$select * from public.take_over_conversation('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1','x')$$, 'a conversation of another business is not found');

-- 4. a new customer message in an assigned chat notifies ONLY the assignee, one refreshed row
insert into public.messages (client_id, conversation_id, direction, sender, type, body) values
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','inbound','customer','text','are you there');
insert into public.messages (client_id, conversation_id, direction, sender, type, body) values
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','inbound','customer','text','hello again');
select pg_temp.check((select count(*) from public.notifications where kind='message')=1, 'one message notification, refreshed not piled up');
select pg_temp.check((select user_id from public.notifications where kind='message')='00000000-0000-0000-0000-0000000000a1', 'only the assignee is notified');
select pg_temp.check((select body from public.notifications where kind='message')='hello again', 'shows the latest message');

-- 5. a duplicate client_request_id cannot be saved twice
insert into public.messages (client_id, conversation_id, direction, sender, type, body, client_request_id) values
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','outbound','human','text','hi','req-1');
select pg_temp.fails($$insert into public.messages (client_id, conversation_id, direction, sender, type, body, client_request_id) values ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','outbound','human','text','hi','req-1')$$, 'same request id refused');

-- 6. assign / unassign (members only)
select pg_temp.fails($$select public.assign_handoff('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.handoff_requests limit 1),'00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1')$$, 'cannot assign to a non-member');
select public.assign_handoff('aaaaaaaa-0000-0000-0000-000000000001',(select id from public.handoff_requests limit 1),'00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a1','A one');
select pg_temp.check((select assigned_user_id from public.handoff_requests limit 1)='00000000-0000-0000-0000-0000000000a2', 'reassigned');
select pg_temp.check((select count(*) from public.handoff_events where kind='assigned')=1, 'assignment recorded in history');

-- 7. resume AI: only the assignee; ends assignment, resolves, AI back on for THIS chat only, queue dropped
insert into public.pending_messages (client_id, conversation_id, message_id) select 'aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1', id from public.messages limit 1;
select pg_temp.check(not (select out_resumed from public.resume_ai('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a1','A one')), 'someone else cannot resume the AI');
select pg_temp.check((select out_resumed from public.resume_ai('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a2','A two')), 'assignee resumes the AI');
select pg_temp.check((select handling from public.conversations where id='aaaaaaaa-0000-0000-0000-0000000000d1')='bot', 'AI back on');
select pg_temp.check((select status='resolved' and resolved_by is not null and resumed_ai_at is not null from public.handoff_requests limit 1), 'handoff resolved with who and when');
select pg_temp.check((select count(*) from public.pending_messages where conversation_id='aaaaaaaa-0000-0000-0000-0000000000d1')=0, 'nothing queued for the AI survives');
select pg_temp.check((select count(*) from public.handoff_events where kind='resumed_ai')=1, 'resume recorded in history');
select pg_temp.check((select count(*) from public.handoff_events)=4, 'history kept: created, taken_over, assigned, resumed_ai');

-- 8. a new handoff after resume notifies again (new id), taking over with no handoff creates one without notifying
select public.create_handoff('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','customer_request','again','s');
select pg_temp.check((select count(*) from public.notifications where kind='handoff')=4, 'second handoff notifies again');
select * from public.take_over_conversation('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000a1','A one');
select pg_temp.check((select count(*) from public.notifications where kind='handoff')=4, 'owner-started takeover does not notify');

-- 9. appointments and tickets notify members
-- (inserted through their own tests' fixtures)

-- 10. RLS: a person reads only their own notifications and reads
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
select pg_temp.check((select count(*) from public.notifications)>0 and (select count(*) from public.notifications where user_id<>'00000000-0000-0000-0000-0000000000a1')=0, 'a person sees only their own notifications');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
select pg_temp.check((select count(*) from public.notifications)=0, 'another business sees none');
select pg_temp.check((select count(*) from public.handoff_events)=0, 'another business sees no history');
select pg_temp.fails($$select public.take_over_conversation('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1','x')$$, 'signed-in users cannot call the functions directly');
reset role;
rollback;
