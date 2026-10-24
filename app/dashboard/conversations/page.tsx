import { EmptyState } from "../../../components/ui";

export default function ConversationsIndex() {
  return (
    <div className="chat-panel">
      <EmptyState icon="chat" title="Select a conversation">Choose a chat on the left to read it, take over, or reply.</EmptyState>
    </div>
  );
}
