import { useRef, useCallback } from "react";
import { useWs } from "../context/WebSocketContext";

export function ChatInput() {
  const { state, send } = useWs();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const text = inputRef.current?.value.trim();
    if (!text || state.busy) return;
    send(text);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = "auto";
    }
  }, [state.busy, send]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const onInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  const disabled = !state.connected || state.busy;

  return (
    <div className="border-t border-border px-5 py-3 flex gap-2 shrink-0">
      <textarea
        ref={inputRef}
        rows={1}
        placeholder="Send a message..."
        disabled={disabled}
        onKeyDown={onKeyDown}
        onInput={onInput}
        className="flex-1 bg-surface border-none rounded-md px-4 py-2 text-text font-mono text-sm outline-none resize-none min-h-[36px] max-h-[120px] overflow-hidden shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06),0_2px_6px_rgba(0,0,0,0.4)] placeholder:text-dim disabled:opacity-50 disabled:cursor-not-allowed"
      />
      <button
        disabled={disabled}
        onClick={handleSend}
        className="bg-text text-bg border-none rounded-md h-9 px-4 py-2 font-mono text-sm font-medium cursor-pointer self-end hover:opacity-90 disabled:opacity-50 disabled:pointer-events-none"
      >
        Send
      </button>
    </div>
  );
}
