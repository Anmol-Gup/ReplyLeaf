import { emailLayout } from "../email/html";
import { oneLine, type MailMessage } from "../email/mailer";

// The emails sent to the business owner about their subscription. Pure (unit-tested). Each one is sent once per
// dedupe key (see claim_billing_email), however many times Stripe repeats an event.

export type BillingEmail =
  | { kind: "subscribed"; periodEnd: Date | null }
  | { kind: "renewed"; periodEnd: Date | null; amount: string | null }
  | { kind: "payment_failed"; graceEndsAt: Date | null; hostedUrl: string | null }
  | { kind: "payment_action_required"; hostedUrl: string | null }
  | { kind: "grace_reminder"; graceEndsAt: Date | null; daysLeft: number }
  | { kind: "canceled_scheduled"; paidThrough: Date | null }
  | { kind: "ended" }
  | { kind: "expired" }
  | { kind: "recovered"; periodEnd: Date | null };

export const formatMoney = (amount: number, currency: string) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

export function billingEmailMessage(e: BillingEmail, o: { to: string; businessName: string; appUrl?: string }): MailMessage {
  const base = o.appUrl?.replace(/\/$/, "");
  const billingUrl = base ? `${base}/dashboard/billing` : null;
  const make = (subject: string, heading: string, paragraphs: string[], button?: { label: string; url: string }): MailMessage => ({
    to: o.to,
    subject: oneLine(subject),
    text: `${paragraphs.join("\n\n")}${button ? `\n\n${button.label}: ${button.url}` : ""}`,
    html: emailLayout({ preheader: paragraphs[0].slice(0, 90), heading, paragraphs, button, footer: `Sent about the ${o.businessName} subscription.` }),
  });
  const manage = billingUrl ? { label: "Open billing", url: billingUrl } : undefined;

  switch (e.kind) {
    case "subscribed":
      return make("Your subscription is active", "Welcome aboard", [
        `Thanks! Your WhatsApp AI Assistant subscription for ${o.businessName} is active.`,
        `Your plan is ₹999 per month and renews automatically${e.periodEnd ? `. The next payment is due on ${day(e.periodEnd)}` : ""}. You can see invoices, update your card or cancel any time from the billing page.`,
      ], manage);
    case "renewed":
      return make("Payment received: thank you", "Payment received", [
        `We received your monthly payment${e.amount ? ` of ${e.amount}` : ""} for ${o.businessName}. Your subscription continues${e.periodEnd ? ` until ${day(e.periodEnd)}` : ""}.`,
      ], manage);
    case "payment_failed":
      return make("Your payment failed: please update your payment method", "Your latest payment failed", [
        `We couldn't take the monthly payment for ${o.businessName}.`,
        e.graceEndsAt
          ? `Your assistant keeps working until ${day(e.graceEndsAt)} (7 days). Please update your payment method before then to avoid an interruption. If it isn't resolved, WhatsApp automation is paused. Nothing is deleted.`
          : "Please update your payment method to switch the subscription on.",
      ], e.hostedUrl ? { label: "Pay now", url: e.hostedUrl } : manage);
    case "payment_action_required":
      return make("Action needed: confirm your payment", "Your bank needs you to confirm the payment", [
        `Your bank asked for extra confirmation before it will approve the payment for ${o.businessName}.`,
        "Please open the link and complete the confirmation. Until then the payment can't go through.",
      ], e.hostedUrl ? { label: "Confirm payment", url: e.hostedUrl } : manage);
    case "grace_reminder":
      return make(`Reminder: ${e.daysLeft} day${e.daysLeft === 1 ? "" : "s"} left to fix your payment`, "Your payment is still outstanding", [
        `Your last payment for ${o.businessName} hasn't been resolved. Your assistant stays on until ${day(e.graceEndsAt)}, then WhatsApp automation is paused.`,
        "Updating your payment method takes a minute, and everything switches back on as soon as payment goes through. Nothing is deleted either way.",
      ], manage);
    case "canceled_scheduled":
      return make("Your subscription will end", "Your cancellation is confirmed", [
        `Your subscription for ${o.businessName} is cancelled and won't renew.${e.paidThrough ? ` You can keep using everything until ${day(e.paidThrough)}.` : ""}`,
        "Changed your mind? You can resubscribe from the billing page any time. Your data is kept.",
      ], manage);
    case "ended":
      return make("Your subscription has ended", "Your subscription has ended", [
        `The subscription for ${o.businessName} has ended, so WhatsApp automation is switched off.`,
        "You can still log in, see your data and export it. Subscribe again to switch the assistant back on.",
      ], manage);
    case "expired":
      return make("Your assistant is paused: payment is overdue", "Your assistant has been paused", [
        `The payment for ${o.businessName} is still outstanding after 7 days, so WhatsApp automation is paused.`,
        "You can still log in, see your data and export it. Update your payment method and everything resumes automatically. Nothing has been deleted.",
      ], manage);
    case "recovered":
      return make("Payment received: your assistant is back on", "You're all set", [
        `Your payment for ${o.businessName} went through, so WhatsApp automation is switched back on${e.periodEnd ? ` and your subscription runs until ${day(e.periodEnd)}` : ""}.`,
      ], manage);
  }
}
