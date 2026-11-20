-- An email address a customer volunteered, in an appointment or support conversation, so we can send updates about THAT request
-- after WhatsApp's 24-hour reply window has closed (we cannot send free-form WhatsApp messages after it, and templates cost money).
-- Kept apart from contacts.email, which the owner confirms: this one is only used to send the customer updates they asked for.
-- Deleted with the contact (a person's data deletion removes it).
alter table public.contacts add column notify_email text;
