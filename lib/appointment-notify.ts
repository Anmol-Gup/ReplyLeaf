import { getMailer } from "./email/mailer";
import { emailLayout } from "./email/html";
import { supabaseAdmin } from "./supabase-admin";
import { sendClientText } from "./supabase-deps";
import { isWithinWindow } from "./whatsapp/window";

// Tells the CUSTOMER about a decision on their request (server only).
//   1. WhatsApp, if the 24-hour window is open (WhatsApp does not allow free-form messages after it).
//   2. Otherwise email, if we have their address.
//   3. Otherwise nothing is sent; the dashboard shows the text so the owner can send it another way.
// Never a WhatsApp template (those cost money). The result says what really happened, and "whatsapp"/"email" are only returned when
// that send actually went through:
//   whatsapp / email = delivered to that channel
//   failed           = we tried a channel and it did not work (and nothing else worked)
//   none             = nothing could be tried: the window is closed and there is no email on file
export type CustomerChannel = "whatsapp" | "email" | "failed" | "none";

export async function notifyCustomer(
  clientId: string, conversationId: string, businessName: string, subject: string, text: string,
): Promise<CustomerChannel> {
  const db = supabaseAdmin();
  const { data: conv } = await db.from("conversations").select("contact_id, last_customer_message_at")
    .eq("id", conversationId).eq("client_id", clientId).maybeSingle();
  if (!conv) return "none";
  const [{ data: client }, { data: contact }] = await Promise.all([
    db.from("clients").select("wa_phone_number_id").eq("id", clientId).single(),
    db.from("contacts").select("phone, email, notify_email").eq("id", conv.contact_id).eq("client_id", clientId).single(),
  ]);

  let attempted = false;
  const last = conv.last_customer_message_at ? new Date(conv.last_customer_message_at) : null;
  if (client?.wa_phone_number_id && contact?.phone && isWithinWindow(last)) {
    const record = (patch: object) => db.from("messages").insert({
      client_id: clientId, conversation_id: conversationId, direction: "outbound", sender: "human", type: "text", body: text, ...patch,
    });
    attempted = true;
    try {
      const sent = await sendClientText(clientId, client.wa_phone_number_id, contact.phone, text);
      await record({ status: "sent", wa_message_id: sent.waMessageId });
      return "whatsapp";
    } catch (e) {
      console.error("customer WhatsApp notice failed", e instanceof Error ? e.message : e);
      await record({ status: "failed", error: "send_failed" });
    }
  }

  const mailer = getMailer();
  const emailTo = (contact?.email ?? contact?.notify_email) as string | null | undefined; // the owner-confirmed email first, else the one they gave for updates
  if (mailer && emailTo) {
    attempted = true;
    try {
      await mailer.send({
        to: emailTo, subject,
        text: `${text}\n\n- ${businessName}`,
        html: emailLayout({ preheader: text.slice(0, 90), heading: subject, paragraphs: [text], brandName: businessName, footer: `You are receiving this because you asked ${businessName} for an appointment on WhatsApp.` }),
      });
      return "email";
    } catch (e) {
      console.error("customer email notice failed", e instanceof Error ? e.message : e);
    }
  }
  return attempted ? "failed" : "none";
}
