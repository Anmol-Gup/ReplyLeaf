-- An optional email address for an appointment, filled in by the owner (for example after speaking to the customer).
-- The assistant never asks for it and never writes it.
alter table public.appointments add column customer_email text;
