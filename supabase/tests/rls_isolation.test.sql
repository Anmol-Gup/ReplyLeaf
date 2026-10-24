-- pgTAP test: one business can never see or touch another's data.
-- Run with:  npx supabase test db      (starts the local stack; needs Docker)
-- NOTE: written alongside the migrations but not executed in the environment
-- where it was authored. Run it before relying on it.
begin;
select plan(13);

-- Fixtures (as the postgres superuser, bypassing RLS)
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@example.com'),
  ('00000000-0000-0000-0000-0000000000b1', 'b@example.com');
insert into public.clients (id, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'Client A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'Client B');
insert into public.client_users (client_id, user_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000a1'),
  ('bbbbbbbb-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000b1');
insert into public.client_secrets (client_id, wa_access_token_enc) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'secret-a'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'secret-b');
insert into public.contacts (id, client_id, phone) values
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', '111'),
  ('bbbbbbbb-0000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-000000000001', '222');

-- Composite foreign keys: a conversation cannot point at ANOTHER client's contact.
select throws_ok(
  $$insert into public.conversations (client_id, contact_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000c1')$$,
  '23503', null, 'cross-tenant conversation -> contact is rejected');

insert into public.conversations (id, client_id, contact_id) values
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1'),
  ('bbbbbbbb-0000-0000-0000-0000000000d1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000c1');
insert into public.messages (client_id, conversation_id, direction, sender, body) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'inbound', 'customer', 'hi A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000d1', 'inbound', 'customer', 'hi B');

select throws_ok(
  $$insert into public.messages (client_id, conversation_id, direction, sender)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000d1', 'inbound', 'customer')$$,
  '23503', null, 'cross-tenant message -> conversation is rejected');

-- Act as owner A (an authenticated browser session)
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

select is((select count(*) from public.clients)::int, 1, 'A sees only their own client');
select is((select count(*) from public.contacts)::int, 1, 'A sees only their own contacts');
select is((select body from public.messages), 'hi A', 'A sees only their own messages');
select is((select count(*) from public.contacts where client_id = 'bbbbbbbb-0000-0000-0000-000000000001')::int, 0,
  'A cannot read B by asking for B''s client_id');

select throws_ok($$select * from public.client_secrets$$, '42501', null, 'tokens are unreachable for owners');
select throws_ok($$select * from public.admin_alerts$$, '42501', null, 'admin alerts are unreachable for owners');
select throws_ok($$select * from public.pending_messages$$, '42501', null, 'batching queue is unreachable for owners');
select throws_ok(
  $$insert into public.contacts (client_id, phone) values ('bbbbbbbb-0000-0000-0000-000000000001', '999')$$,
  '42501', null, 'owners cannot write directly (writes go through server routes)');
select throws_ok(
  $$select public.record_inbound_message('aaaaaaaa-0000-0000-0000-000000000001', '1', null, 'w', 'text', 'x', now())$$,
  '42501', null, 'server-only functions cannot be called with an owner session');

-- Anonymous visitor
reset role;
set local role anon;
select throws_ok($$select * from public.contacts$$, '42501', null, 'anonymous visitors read nothing');

select * from finish();
rollback;
