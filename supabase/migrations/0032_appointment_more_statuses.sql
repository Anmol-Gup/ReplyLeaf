-- Appointments get two more statuses the owner can set: 'rescheduled' (moved to a new agreed date and time) and 'no_show' (the customer
-- did not turn up). The existing six stay valid, so nothing already saved changes.
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments add constraint appointments_status_check
  check (status in ('pending', 'confirmed', 'rescheduled', 'reschedule_requested', 'rejected', 'cancelled', 'completed', 'no_show'));
