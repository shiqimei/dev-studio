import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";

export function ChatPanel() {
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <MessageList />
      <ChatInput />
    </div>
  );
}
