-- Stage 1 schema. Rules followed in every migration:
--   * every tenant table has client_id
--   * RLS is enabled in the SAME migration that creates the table
--   * composite foreign keys (id, client_id) make it impossible for a row to
--     point at a parent that belongs to a different client
-- Never change the database by hand: add a new numbered file instead.

create extension if not exists vector;
create extension if not exists pgcrypto;

-- Start from zero access: tables created below grant nothing to the browser
-- roles by default. Each table then grants back only what the dashboard reads
-- (writes from the dashboard go through server routes in Stage 4).
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- ---------------------------------------------------------------- clients
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'left')),
  left_at timestamptz,                         -- retention: contacts deleted 12 months after this
  wa_phone_number_id text unique,              -- routes incoming webhooks to a client
  wa_waba_id text,
  ai_provider text not null default 'gemini' check (ai_provider in ('gemini', 'openai')),
  business_info text,
  business_hours text,
  booking_link text,                           -- optional, e.g. Calendly
  kb_text text,                                -- Stage 2: knowledge base pasted as text
  monthly_message_cap integer not null default 1000,
  created_at timestamptz not null default now()
);
alter table public.clients enable row level security;

-- Secrets live in their own table: RLS on, no policy, no grant, so tokens can
-- never reach the browser through the dashboard's Supabase client.
create table public.client_secrets (
  client_id uuid primary key references public.clients (id) on delete cascade,
  wa_access_token_enc text,                    -- AES-256-GCM, see lib/crypto.ts
  created_at timestamptz not null default now()
);
alter table public.client_secrets enable row level security;

-- ------------------------------------------------------------ client_users
-- Which Supabase Auth users (business owners) may see which client.
create table public.client_users (
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'owner',
  primary key (client_id, user_id)
);
create index client_users_user_id_idx on public.client_users (user_id);
alter table public.client_users enable row level security;

-- Which clients does the current user belong to? SECURITY DEFINER so the
-- lookup itself isn't blocked by RLS on client_users. Used by every policy.
create function public.current_client_ids()
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select client_id from public.client_users where user_id = (select auth.uid())
$$;
revoke execute on function public.current_client_ids() from public, anon;
grant execute on function public.current_client_ids() to authenticated;

-- Policies for the three tables above (they exist now, so we can write them).
grant select on public.clients, public.client_users to authenticated;
create policy "members read own client" on public.clients
  for select to authenticated using (id in (select public.current_client_ids()));
create policy "read own membership" on public.client_users
  for select to authenticated using (user_id = (select auth.uid()));

-- --------------------------------------------------------------- contacts
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  phone text not null,                         -- digits only, as WhatsApp sends it
  name text,
  email text,
  status text not null default 'new',
  tags text[] not null default '{}',
  notes text,
  suggested jsonb not null default '{}',       -- model guesses, confirmed by the owner before use
  created_at timestamptz not null default now(),
  unique (client_id, phone),
  unique (id, client_id)
);
alter table public.contacts enable row level security;
grant select on public.contacts to authenticated;
create policy "members read contacts" on public.contacts
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- ----------------------------------------------------------- conversations
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  contact_id uuid not null,
  handling text not null default 'bot' check (handling in ('bot', 'human_active')),
  failed_answer_count integer not null default 0,
  last_customer_message_at timestamptz,        -- drives the 24-hour window
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, contact_id),
  unique (id, client_id),
  foreign key (contact_id, client_id) references public.contacts (id, client_id) on delete cascade
);
alter table public.conversations enable row level security;
grant select on public.conversations to authenticated;
create policy "members read conversations" on public.conversations
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- --------------------------------------------------------------- messages
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  conversation_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  sender text not null check (sender in ('customer', 'bot', 'human')),
  type text not null default 'text',
  body text,                                   -- nulled by the 12-month retention job
  wa_message_id text unique,                   -- dedupe key (nulls allowed for blocked/failed sends)
  wa_timestamp timestamptz,
  status text,                                 -- outbound: sent | delivered | read | failed | blocked
  error text,
  input_tokens integer,
  output_tokens integer,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, client_id) references public.conversations (id, client_id) on delete cascade
);
create index messages_conversation_idx on public.messages (client_id, conversation_id, created_at);
alter table public.messages enable row level security;
grant select on public.messages to authenticated;
create policy "members read messages" on public.messages
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- -------------------------------------------------------- booking_requests
create table public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  contact_id uuid not null,
  conversation_id uuid,
  service text,
  preferred_time text,
  name text,
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'declined')),
  created_at timestamptz not null default now(),
  foreign key (contact_id, client_id) references public.contacts (id, client_id) on delete cascade,
  foreign key (conversation_id, client_id) references public.conversations (id, client_id) on delete cascade
);
create index booking_requests_client_idx on public.booking_requests (client_id, status);
alter table public.booking_requests enable row level security;
grant select on public.booking_requests to authenticated;
create policy "members read booking requests" on public.booking_requests
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- ----------------------------------------------------------- kb_documents
create table public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  title text not null,
  content text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (id, client_id)
);
alter table public.kb_documents enable row level security;
grant select on public.kb_documents to authenticated;
create policy "members read kb documents" on public.kb_documents
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- -------------------------------------------------------------- kb_chunks
-- `embedding` has NO fixed dimension on purpose. Stage 5 picks the embedding
-- model and a later migration will set the dimension (alter column ... type
-- vector(N)) and add the vector index, which needs a fixed dimension.
create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  document_id uuid not null,
  heading text,
  content text not null,
  embedding vector,
  embedding_model text,
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now(),
  foreign key (document_id, client_id) references public.kb_documents (id, client_id) on delete cascade
);
create index kb_chunks_client_idx on public.kb_chunks (client_id);
create index kb_chunks_fts_idx on public.kb_chunks using gin (fts);
alter table public.kb_chunks enable row level security;
grant select on public.kb_chunks to authenticated;
create policy "members read kb chunks" on public.kb_chunks
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- ----------------------------------------------------------- usage_events
create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  message_id uuid references public.messages (id) on delete set null,
  kind text not null,                          -- e.g. 'reply', 'embedding'
  provider text,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now()
);
create index usage_events_client_idx on public.usage_events (client_id, created_at);
alter table public.usage_events enable row level security;
grant select on public.usage_events to authenticated;
create policy "members read usage" on public.usage_events
  for select to authenticated using (client_id in (select public.current_client_ids()));

-- ------------------------------------------------------------ admin_alerts
-- Admin only: RLS on, no policy, no grant. client_id is nullable because some
-- failures happen before we know which client a message belongs to.
create table public.admin_alerts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on delete set null,
  kind text not null,
  detail text,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.admin_alerts enable row level security;
