-- Stage 1 schema. Every tenant table carries client_id.
-- Composite foreign keys (id, client_id) make it impossible for a row to point
-- at a parent that belongs to a different client.

create extension if not exists pgcrypto;
create extension if not exists vector with schema extensions;

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

-- Secrets live in their own table: authenticated users get NO access to it,
-- so tokens can never reach the browser through the dashboard's Supabase client.
create table public.client_secrets (
  client_id uuid primary key references public.clients (id) on delete cascade,
  wa_access_token_enc text,                    -- AES-256-GCM, see lib/crypto.ts
  created_at timestamptz not null default now()
);

-- Which Supabase Auth users (business owners) may see which client.
create table public.client_users (
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'owner',
  primary key (client_id, user_id)
);
create index client_users_user_id_idx on public.client_users (user_id);

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

create table public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  title text not null,
  content text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (id, client_id)
);

-- Dimension 1536 is a placeholder; confirm against the embedding model chosen in Stage 5.
create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  document_id uuid not null,
  heading text,
  content text not null,
  embedding extensions.vector(1536),
  embedding_model text,
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now(),
  foreign key (document_id, client_id) references public.kb_documents (id, client_id) on delete cascade
);
create index kb_chunks_client_idx on public.kb_chunks (client_id);
create index kb_chunks_fts_idx on public.kb_chunks using gin (fts);

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

-- client_id is nullable here: some failures happen before we know the client.
create table public.admin_alerts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients (id) on delete set null,
  kind text not null,
  detail text,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);
