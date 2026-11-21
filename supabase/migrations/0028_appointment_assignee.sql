-- Appointments can be assigned to a person by email (the same way tickets and handoffs can). Free text, no account needed:
-- a member of the business is matched by email, anyone else is simply recorded and emailed.
alter table public.appointments add column assigned_to text check (assigned_to is null or char_length(assigned_to) <= 200);
