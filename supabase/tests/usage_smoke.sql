-- Smoke test for WhatsApp usage tracking (migration 0020). Throwaway Postgres with migrations 0001-0020 and stubbed Supabase roles only.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','a@x.com'),('00000000-0000-0000-0000-0000000000b1','b@x.com');
insert into public.clients (id, name, wa_phone_number_id) values ('aaaaaaaa-0000-0000-0000-000000000001','A','PNA'),('bbbbbbbb-0000-0000-0000-000000000001','B','PNB');
insert into public.client_users (client_id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1'),('bbbbbbbb-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1');
insert into public.contacts (id, client_id, phone) values ('aaaaaaaa-0000-0000-0000-0000000000c1','aaaaaaaa-0000-0000-0000-000000000001','111'),('bbbbbbbb-0000-0000-0000-0000000000c1','bbbbbbbb-0000-0000-0000-000000000001','222');
insert into public.conversations (id, client_id, contact_id) values ('aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1'),('bbbbbbbb-0000-0000-0000-0000000000d1','bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000c1');
create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;

-- business A: inbound (never counted), AI reply, owner dashboard reply, an owner reply typed in the Business app, a failed one, a blocked one, a template
insert into public.messages (client_id, conversation_id, direction, sender, type, wa_message_id, status) values
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','inbound','customer','text','in1',null);
insert into public.messages (client_id, conversation_id, direction, sender, type, wa_message_id, status) values
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','outbound','bot','text','ai1','sent'),
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','outbound','human','text','own1','sent'),
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','outbound','bot','text','ai2','sent'),
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','outbound','bot','text','ai3','sent');
insert into public.messages (client_id, conversation_id, direction, sender, type, body, status) values
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','outbound','bot','text','blocked one','blocked');
insert into public.messages (client_id, conversation_id, direction, sender, via, type, wa_message_id, status) values
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','outbound','human','business_app','text','app1','sent');
insert into public.messages (client_id, conversation_id, direction, sender, type, wa_category, wa_message_id, status) values
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','outbound','bot','template','utility','tpl1','sent'),
 ('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','outbound','bot','template','marketing','tpl2','sent');
insert into public.messages (client_id, conversation_id, direction, sender, type, wa_message_id, status) values
 ('bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000d1','outbound','bot','text','bai1','sent');

select pg_temp.check((select phone_number_id from public.messages where wa_message_id='ai1')='PNA', 'the sending phone number is filled in automatically');
select pg_temp.check((select phone_number_id from public.messages where wa_message_id='bai1')='PNB', 'and it is the right business''s number');
select pg_temp.check((select phone_number_id is null from public.messages where wa_message_id='in1'), 'inbound messages carry no sending number');

-- statuses: sent -> delivered -> read, duplicates and out-of-order webhooks
select pg_temp.check(public.apply_message_status('ai1','delivered',null,null,now()), 'sent -> delivered changes the row');
select pg_temp.check(not public.apply_message_status('ai1','delivered',null,null,now()), 'a duplicate delivered webhook changes nothing');
select pg_temp.check(not public.apply_message_status('ai1','sent',null,null,now()), 'a late "sent" cannot move a delivered message back');
select pg_temp.check(not public.apply_message_status('ai1','failed','late',131000,now()), 'a delivered message is never turned into failed');
select pg_temp.check(public.apply_message_status('ai1','read',null,null,now()), 'delivered -> read');
select pg_temp.check(not public.apply_message_status('ai1','delivered',null,null,now()), 'read cannot go back to delivered');
select pg_temp.check((select delivered_at is not null from public.messages where wa_message_id='ai1'), 'delivered_at is recorded');
select pg_temp.check(public.apply_message_status('own1','delivered',null,null,now()), 'owner (dashboard) reply delivered');
select pg_temp.check(public.apply_message_status('ai2','failed','payment issue',131042,now()), 'accepted by the API, delivery later fails');
select pg_temp.check((select error_code from public.messages where wa_message_id='ai2')=131042, 'the Meta error code is stored');
select pg_temp.check(not public.apply_message_status('ai2','delivered',null,null,now()), 'a failed message stays failed');
select pg_temp.check(not public.apply_message_status('nope','delivered',null,null,now()), 'a status for an unknown message id is ignored');
select pg_temp.check(public.apply_message_status('tpl1','delivered',null,null,now()) and public.apply_message_status('tpl2','delivered',null,null,now()), 'template messages delivered');
select pg_temp.check(not public.apply_message_status('in1','delivered',null,null,now()), 'an inbound message is never touched by a status');

-- the summary: per phone number and category; only api messages; blocked ones never counted; ai3 is still awaiting
create temp table s as select * from public.wa_usage_summary('aaaaaaaa-0000-0000-0000-000000000001', now() - interval '1 day', now() + interval '1 day');
select pg_temp.check((select out_delivered from s where out_category='service')=2, 'service messages delivered: AI reply + owner dashboard reply');
select pg_temp.check((select out_failed from s where out_category='service')=1, 'one failed service message');
select pg_temp.check((select out_awaiting from s where out_category='service')=1, 'one service message still awaiting a delivery update');
select pg_temp.check((select out_total from s where out_category='service')=4, 'blocked messages and business-app messages are not counted (4 api service messages)');
select pg_temp.check((select out_delivered from s where out_category='utility')=1 and (select out_delivered from s where out_category='marketing')=1, 'utility and marketing templates are counted in their own categories');
select pg_temp.check((select count(distinct out_phone_number_id) from s)=1, 'everything is under this business''s phone number');

-- tenant isolation: each owner sees only their own usage (row level security applies to the function)
grant select on public.messages to authenticated;  -- table privileges as Supabase grants by default
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
select pg_temp.check((select count(*) from public.wa_usage_summary('aaaaaaaa-0000-0000-0000-000000000001', now() - interval '1 day', now() + interval '1 day'))=0, 'owner B gets nothing for business A (cross-tenant read blocked)');
select pg_temp.check((select sum(out_total) from public.wa_usage_summary('bbbbbbbb-0000-0000-0000-000000000001', now() - interval '1 day', now() + interval '1 day'))=1, 'owner B sees only business B''s own usage');
do $$ begin begin perform public.apply_message_status('bai1','delivered',null,null,now()); exception when insufficient_privilege then raise notice 'ok - owners cannot call apply_message_status'; return; end; raise exception 'FAILED: callable by an owner'; end $$;
rollback;
