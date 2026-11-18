# WhatsApp messaging costs: what Replyleaf shows and does

Source: the pricing reference supplied on 18 November 2026 (Meta's pricing change effective 1 October 2026). Rates change; always check
Meta's current rate card for the destination country. Never hard-code a per-message rate.

## What the customer pays, and to whom (keep these separate)
1. **Replyleaf subscription**: ₹999 per month, paid to Replyleaf (Stripe).
2. **AI usage**: paid directly to the customer's AI provider with their own key (BYOK).
3. **WhatsApp messaging**: paid to Meta through the customer's own WhatsApp Business Account (or their messaging provider). Replyleaf does
   not pay or collect it, and never folds it into the subscription.

## The free service-message allowance
- The first **1,000 delivered service messages per business phone number per month** are free, resetting monthly (Meta: 12 am in the
  messaging account's time zone). Unused messages do not carry over.
- Customer messages never count. The assistant's replies and replies sent from the dashboard do. Marketing, utility and authentication
  templates are separate categories and are not covered by the allowance (Replyleaf sends none).
- After 1,000, service messages are charged at the destination market's rate. Do not advertise "unlimited free WhatsApp".
- Payment behaviour differs by billing set-up (direct Meta billing vs a provider wallet). Do not promise delivery without a valid payment method.

## What Replyleaf does
- **Onboarding and Settings > WhatsApp**: tells the owner that Meta's charges are separate and managed through their WhatsApp account.
- **Usage page**: an estimate of service messages delivered this month, free used, free left, paid, the reset date (in the business's time
  zone if set, else UTC) and recent delivery errors. It counts only outbound messages WhatsApp reported as delivered or read. Messages typed
  in the WhatsApp Business app (coexistence) are not sent through Replyleaf and are not counted. Meta's bill is the source of truth.
- **Billing page**: the three costs listed above.
- **When WhatsApp refuses or fails to deliver** (`lib/whatsapp/errors.ts`): the error code and message are classified as billing, account,
  permission, policy, window, rate limit or delivery.
  - Billing, account, permission and policy problems are **not retried** and **no fallback message is sent**. Nothing is recorded as sent, the
    customer's message and chat are kept, the admin alert records Meta's code and message, and the owner is emailed once a day per kind of problem.
  - Other failures keep the earlier behaviour (admin alert, one fallback attempt).
  - Asynchronous "failed" delivery statuses from the webhook are classified the same way.

## References
- Meta, WhatsApp Business Platform pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Meta, WhatsApp Business FAQ: https://whatsappbusiness.com/resources/faq/

## Usage tracking design (migration 0020)
No new table: the existing `messages` table gained `wa_category` (service / marketing / utility / authentication / unknown), `via` (`api` =
sent through Replyleaf, `business_app` = typed in the WhatsApp Business app), `phone_number_id` (filled by a trigger), `delivered_at` and
`error_code`. `clients` gained `wa_free_allowance` (eligible / not_eligible / unknown, default unknown), `wa_billing_ack_at` (the onboarding
acknowledgement) and `last_webhook_at`.

- **Idempotency:** `messages.wa_message_id` is unique, and `apply_message_status()` only moves forward (sent -> delivered -> read). Duplicate or
  out-of-order webhooks change nothing, a delivered message is never turned into failed, `delivered_at` is set once.
- **What counts:** outbound, `via = api`, status delivered or read, grouped per phone number and category over the period
  (`wa_usage_summary()`, security invoker so row level security applies). Blocked messages (never sent), failed ones, ones still awaiting a
  delivery update, customer messages and Business-app messages are never counted as delivered usage.
- **Category:** decided by how the message was sent (`messageCategory`): free-form text is a service message, a template carries its own
  category, a template with no known category is `unknown` (never guessed from text). Replyleaf sends no templates today.
- **Formulas** (`summariseUsage`): `free_remaining = max(0, 1000 - delivered_service)`, `chargeable = max(0, delivered_service - 1000)`;
  not_eligible means a 0 allowance; unknown keeps the estimate but is labelled as unconfirmed. At 80% a neutral notice is shown.
- **Period:** the business's time zone (Settings > Workflows) or UTC, from the 1st of the month. Meta's pricing page says the tier resets at 12am in
  the messaging account's time zone; the account's own zone is not read, so this is an estimate.
- **Direct from Meta:** delivery statuses and error codes (webhooks), accepted message ids. **Estimated locally:** everything else. Replyleaf does
  NOT call a Meta billing or pricing-analytics API and cannot see payment methods or payment status; the UI says "Billing status unavailable" and links to
  WhatsApp Manager (https://business.facebook.com/wa/manage/home/). Meta's `pricing_analytics` could become an authoritative source later.
- **Errors:** billing / account / permission / policy refusals are not retried and email the owner once a day. Temporary refusals (HTTP 429/503 or
  codes 130429, 131016, 2, 4, 17, 32, 613, 80007) are retried up to 3 times with 1s then 2s waits. Timeouts and unexplained 500s are NOT retried,
  because the message may already have been sent and a retry would duplicate it.
- **Permissions:** the existing `whatsapp_business_management` and `whatsapp_business_messaging`. Nothing new.
- **Manual Meta configuration:** the webhook must be subscribed to `messages` (this also carries delivery statuses).
- **Admin:** `/admin/whatsapp` (admin only, read-only, no tokens or payment data).
