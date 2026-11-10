import Icon from "../Icon";

// An illustrative conversation (original text, fictional business). It shows what the product does today:
// an answer from the business's knowledge, then an appointment REQUEST that the owner still has to confirm.
const MESSAGES: { from: "customer" | "assistant"; text: string; time: string }[] = [
  { from: "customer", text: "Hi! Do you do teeth whitening?", time: "10:02" },
  { from: "assistant", text: "Hello! Yes, we do. A whitening session takes about an hour and costs $120. Would you like to book one?", time: "10:02" },
  { from: "customer", text: "Yes please. Could I come this Friday around 5pm?", time: "10:03" },
  { from: "assistant", text: "Happy to pass that on. So: teeth whitening, this Friday around 5pm, for Asha. Is that right?", time: "10:03" },
  { from: "customer", text: "Yes, that's right.", time: "10:04" },
  { from: "assistant", text: "Thanks! Your appointment request has been submitted. Our team will review your preferred time and get back to you with confirmation.", time: "10:04" },
];

export default function ChatPreview() {
  return (
    <figure className="lp-chat" aria-label="Product preview: an example WhatsApp conversation">
      <div className="lp-chat-head">
        <span className="lp-chat-avatar" aria-hidden="true">S</span>
        <div className="lp-chat-who">
          <strong>Sunrise Dental</strong>
          <span>online</span>
        </div>
        <span className="lp-chat-tag">Product preview</span>
      </div>
      <ol className="lp-chat-body">
        {MESSAGES.map((m, i) => (
          <li key={i} className={`lp-msg ${m.from === "customer" ? "lp-msg-in" : "lp-msg-out"}`} style={{ ["--i" as string]: i }}>
            <span className="sr-only">{m.from === "customer" ? "Customer: " : "Assistant: "}</span>
            {m.text}
            <span className="lp-msg-meta" aria-hidden="true">
              {m.time}
              {m.from === "assistant" && <Icon name="check" size={12} />}
            </span>
          </li>
        ))}
      </ol>
      <div className="lp-chat-foot">
        <span className="lp-dot" aria-hidden="true" />
        <span><strong>Request pending confirmation.</strong> The owner has been emailed.</span>
      </div>
      <figcaption className="lp-chat-note">Illustrative conversation. Not real customer data.</figcaption>
    </figure>
  );
}
