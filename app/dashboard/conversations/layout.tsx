import ConversationList from "../../../components/ConversationList";
import { ConversationsShell } from "../../../components/ConversationsShell";
import { PageHeader } from "../../../components/ui";
import AutoRefresh from "../AutoRefresh";

// Left pane: the conversation list (client component: filters, search and live refresh through /api/conversations). Right pane: the page.
export default function ConversationsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AutoRefresh />
      <PageHeader title="Conversations" description="Chats with your customers. Take over a chat to reply yourself." />
      <ConversationsShell list={<ConversationList />}>{children}</ConversationsShell>
    </>
  );
}
