-- Removes the old booking-request feature's table and function. The assistant no longer collects "booking requests";
-- appointment requests (the `appointments` table) replaced them. Nothing in the app reads or writes this table.
-- WARNING: any rows left in booking_requests are deleted by this migration.
drop function if exists public.save_booking_request(uuid, uuid, uuid, text, text, text);
drop table if exists public.booking_requests;
