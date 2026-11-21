import ConversationsWorkspace from "../../../components/ConversationList";
import { PageHeader } from "../../../components/ui";
import AutoRefresh from "../AutoRefresh";

// The workspace is a client component (filters, search and live refresh through /api/conversations); the page is the chat and its details.
export default function ConversationsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AutoRefresh />
      <PageHeader title="Conversations" description="All customer conversations in one place. Take over any chat or let the assistant handle it." />
      <ConversationsWorkspace>{children}</ConversationsWorkspace>
    </>
  );
}
