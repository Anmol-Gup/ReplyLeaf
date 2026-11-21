-- Private notes over time on contacts and appointments (tickets already have them, migration 0025).
-- Each note keeps its author and time and is never shown to customers or used by the assistant. The older single-note columns
-- (contacts.notes, appointments.internal_notes) are left as they are and shown as "Earlier note".
-- Tenant-scoped (composite foreign keys), readable by the business's own members only, written only by server code.

alter table public.appointments add constraint appointments_id_client_key unique (id, client_id);

create table public.contact_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  contact_id uuid not null,
  author_user_id uuid references auth.users (id) on delete set null,
  author_label text,
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (contact_id, client_id) references public.contacts (id, client_id) on delete cascade
);
create index contact_notes_contact on public.contact_notes (contact_id, created_at);
alter table public.contact_notes enable row level security;
grant select on public.contact_notes to authenticated;
create policy "members read contact notes" on public.contact_notes
  for select to authenticated using (client_id in (select public.current_client_ids()));

create table public.appointment_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  appointment_id uuid not null,
  author_user_id uuid references auth.users (id) on delete set null,
  author_label text,
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  foreign key (appointment_id, client_id) references public.appointments (id, client_id) on delete cascade
);
create index appointment_notes_appointment on public.appointment_notes (appointment_id, created_at);
alter table public.appointment_notes enable row level security;
grant select on public.appointment_notes to authenticated;
create policy "members read appointment notes" on public.appointment_notes
  for select to authenticated using (client_id in (select public.current_client_ids()));
