-- Row Level Security. The service role (our server) bypasses RLS and filters by
-- client_id in code; RLS protects every path that uses a signed-in owner's JWT.

-- Start from zero access, then grant back only what the dashboard reads.
-- (Writes from the dashboard go through server routes in Stage 4.)
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- Which clients does the current user belong to? SECURITY DEFINER so the
-- lookup itself isn't blocked by RLS on client_users.
create function public.current_client_ids()
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select client_id from public.client_users where user_id = (select auth.uid())
$$;
revoke execute on function public.current_client_ids() from public, anon;
grant execute on function public.current_client_ids() to authenticated;

alter table public.clients          enable row level security;
alter table public.client_secrets   enable row level security;  -- no policy, no grant: unreachable
alter table public.client_users     enable row level security;
alter table public.contacts         enable row level security;
alter table public.conversations    enable row level security;
alter table public.messages         enable row level security;
alter table public.booking_requests enable row level security;
alter table public.kb_documents     enable row level security;
alter table public.kb_chunks        enable row level security;
alter table public.usage_events     enable row level security;
alter table public.admin_alerts     enable row level security;  -- admin only: no policy, no grant

grant select on public.clients, public.client_users, public.contacts, public.conversations,
  public.messages, public.booking_requests, public.kb_documents, public.kb_chunks,
  public.usage_events to authenticated;

create policy "members read own client" on public.clients
  for select to authenticated using (id in (select public.current_client_ids()));

create policy "read own membership" on public.client_users
  for select to authenticated using (user_id = (select auth.uid()));

create policy "members read contacts" on public.contacts
  for select to authenticated using (client_id in (select public.current_client_ids()));
create policy "members read conversations" on public.conversations
  for select to authenticated using (client_id in (select public.current_client_ids()));
create policy "members read messages" on public.messages
  for select to authenticated using (client_id in (select public.current_client_ids()));
create policy "members read booking requests" on public.booking_requests
  for select to authenticated using (client_id in (select public.current_client_ids()));
create policy "members read kb documents" on public.kb_documents
  for select to authenticated using (client_id in (select public.current_client_ids()));
create policy "members read kb chunks" on public.kb_chunks
  for select to authenticated using (client_id in (select public.current_client_ids()));
create policy "members read usage" on public.usage_events
  for select to authenticated using (client_id in (select public.current_client_ids()));
