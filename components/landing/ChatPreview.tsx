import Icon from "../Icon";

// An illustrative conversation (original text, fictional business). It shows what the product does today:
// answers from the business's knowledge, the booking link, and a new lead for the owner.
const MESSAGES: { from: "customer" | "assistant"; text: string; time: string }[] = [
  { from: "customer", text: "Hi! Do you do teeth whitening?", time: "10:02" },
  { from: "assistant", text: "Hello! Yes, we do. A whitening session takes about an hour and costs $120. Would you like to book one?", time: "10:02" },
  { from: "customer", text: "Yes please, sometime this week.", time: "10:03" },
  { from: "assistant", text: "Great! You can choose a time that suits you here: book.example.com/sunrise-dental", time: "10:03" },
  { from: "customer", text: "Perfect, thank you!", time: "10:04" },
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
        <span><strong>New lead</strong> saved to the dashboard, owner emailed</span>
      </div>
      <figcaption className="lp-chat-note">Illustrative conversation. Not real customer data.</figcaption>
    </figure>
  );
}
