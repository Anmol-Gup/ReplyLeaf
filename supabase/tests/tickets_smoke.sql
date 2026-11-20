-- Smoke test for ticket assignment, notes and activity (migration 0025). Throwaway Postgres with all migrations and stubbed Supabase roles.
\set ON_ERROR_STOP on
begin;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000a1','a@x.com'),('00000000-0000-0000-0000-0000000000b1','b@x.com');
insert into public.clients (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001','A'),('bbbbbbbb-0000-0000-0000-000000000001','B');
insert into public.client_users (client_id, user_id) values ('aaaaaaaa-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1'),('bbbbbbbb-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000b1');
insert into public.contacts (id, client_id, phone) values ('aaaaaaaa-0000-0000-0000-0000000000c1','aaaaaaaa-0000-0000-0000-000000000001','111'),('bbbbbbbb-0000-0000-0000-0000000000c1','bbbbbbbb-0000-0000-0000-000000000001','222');
insert into public.conversations (id, client_id, contact_id) values ('aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000c1'),('bbbbbbbb-0000-0000-0000-0000000000d1','bbbbbbbb-0000-0000-0000-000000000001','bbbbbbbb-0000-0000-0000-0000000000c1');
create function pg_temp.check(ok boolean, msg text) returns void language plpgsql as $$ begin if not ok then raise exception 'FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
create function pg_temp.fails(sql text, msg text) returns void language plpgsql as $$ begin begin execute sql; exception when others then raise notice 'ok - % (%)', msg, sqlerrm; return; end; raise exception 'FAILED (no error): %', msg; end $$;

-- a ticket that existed before: no invented history
insert into public.tickets (id, client_id, conversation_id, contact_id, customer_phone, subject, description, dedupe_key)
values ('aaaaaaaa-0000-0000-0000-0000000000e1','aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','111','old','an older ticket here','k0');
select pg_temp.check((select count(*) from public.ticket_events where ticket_id='aaaaaaaa-0000-0000-0000-0000000000e1')=0, 'an existing ticket gets no invented events');

-- a ticket created by the assistant records its own created event, once
create temp table c1 as select * from public.create_ticket('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','Ann','111','Order late','Order 4521 has not arrived','delivery','4521','normal','sum','k1');
select pg_temp.check((select out_created from c1), 'a new ticket is created');
select pg_temp.check((select count(*) from public.ticket_events e join c1 on e.ticket_id=c1.out_id where e.kind='created' and e.actor_label is null)=1, 'its created event is recorded (by the assistant)');
create temp table c2 as select * from public.create_ticket('aaaaaaaa-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-0000000000c1','Ann','111','Order late','Order 4521 has not arrived','delivery','4521','normal','sum','k1');
select pg_temp.check(not (select out_created from c2) and (select count(*) from public.ticket_events e join c1 on e.ticket_id=c1.out_id)=1, 'the same ticket again creates no second event');

-- notes: several, each with author and time, never overwriting
insert into public.ticket_notes (client_id, ticket_id, author_user_id, author_label, body) select 'aaaaaaaa-0000-0000-0000-000000000001', out_id, '00000000-0000-0000-0000-0000000000a1', 'a@x.com', 'first note' from c1;
insert into public.ticket_notes (client_id, ticket_id, author_user_id, author_label, body) select 'aaaaaaaa-0000-0000-0000-000000000001', out_id, '00000000-0000-0000-0000-0000000000a1', 'a@x.com', 'second note' from c1;
select pg_temp.check((select count(*) from public.ticket_notes)=2, 'several notes can be added to one ticket');
select pg_temp.fails($$insert into public.ticket_notes (client_id, ticket_id, body) select 'aaaaaaaa-0000-0000-0000-000000000001', out_id, '   ' from c1$$, 'an empty note is rejected');
-- tenant safety: a note or event for business B cannot point at business A's ticket
select pg_temp.fails($$insert into public.ticket_notes (client_id, ticket_id, body) select 'bbbbbbbb-0000-0000-0000-000000000001', out_id, 'x' from c1$$, 'a note cannot attach to another business''s ticket');
select pg_temp.fails($$insert into public.ticket_events (client_id, ticket_id, kind) select 'bbbbbbbb-0000-0000-0000-000000000001', out_id, 'status' from c1$$, 'an event cannot attach to another business''s ticket');
select pg_temp.fails($$insert into public.ticket_events (client_id, ticket_id, kind) select 'aaaaaaaa-0000-0000-0000-000000000001', out_id, 'bogus' from c1$$, 'an unknown event kind is rejected');
-- assignment is a real user id
update public.tickets set assigned_user_id='00000000-0000-0000-0000-0000000000a1' where id='aaaaaaaa-0000-0000-0000-0000000000e1';
select pg_temp.fails($$update public.tickets set assigned_user_id=gen_random_uuid() where id='aaaaaaaa-0000-0000-0000-0000000000e1'$$, 'a made-up user id cannot be assigned');

-- row level security: each owner sees only their own business's notes and events
grant select on public.tickets, public.ticket_notes, public.ticket_events to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1', true);
select pg_temp.check((select count(*) from public.ticket_notes)=0 and (select count(*) from public.ticket_events)=0, 'owner B sees none of business A''s notes or events');
select pg_temp.fails($$insert into public.ticket_notes (client_id, ticket_id, body) values ('bbbbbbbb-0000-0000-0000-000000000001', gen_random_uuid(), 'x')$$, 'owners cannot write notes directly (server only)');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000a1', true);
select pg_temp.check((select count(*) from public.ticket_notes)=2 and (select count(*) from public.ticket_events)=1, 'owner A sees their own notes and events');
rollback;
