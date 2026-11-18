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
