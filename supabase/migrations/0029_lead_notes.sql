-- Dated private notes on leads (contacts, tickets and appointments already have them). Each note keeps its author and time and is
-- never shown to customers. The older single leads.internal_notes column is left as it is and shown as "Earlier note".
-- Tenant-scoped (composite foreign key), readable by the business's own members only, written only by server code.

alter table public.leads add constraint leads_id_client_key unique (id, client_id);

create table public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  lead_id uuid not null,
  author_user_id uuid references auth.users (id) on delete set null,
  author_label text,
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (lead_id, client_id) references public.leads (id, client_id) on delete cascade
);
create index lead_notes_lead on public.lead_notes (lead_id, created_at);
alter table public.lead_notes enable row level security;
grant select on public.lead_notes to authenticated;
create policy "members read lead notes" on public.lead_notes
  for select to authenticated using (client_id in (select public.current_client_ids()));
