import { useRef, useCallback, useState, useEffect } from "react";
import { useWs } from "../context/WebSocketContext";
import { toSupportedImage } from "../utils";
import type { ImageAttachment, FileAttachment, SlashCommand } from "../types";

// ── localStorage helpers for session-scoped draft persistence ──
const DRAFT_KEY_PREFIX = "chatInput:draft:";

function saveDraft(sessionId: string | null, text: string) {
  if (!sessionId) return;
  const key = DRAFT_KEY_PREFIX + sessionId;
  if (text) {
    localStorage.setItem(key, text);
  } else {
    localStorage.removeItem(key);
  }
}

function loadDraft(sessionId: string | null): string {
  if (!sessionId) return "";
  return localStorage.getItem(DRAFT_KEY_PREFIX + sessionId) ?? "";
}

/** Get the basename from a file path. */
function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function ChatInput() {
  const { state, send, interrupt, cancelQueued, searchFiles, requestCommands } = useWs();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);

  // ── Undo/redo history ──
  const undoStack = useRef<string[]>([]);
  const redoStack = useRef<string[]>([]);
  const lastSnapshotRef = useRef("");

  /** Push current value onto undo stack (call before changing the value). */
  const pushUndo = useCallback(() => {
    const val = inputRef.current?.value ?? "";
    if (val !== lastSnapshotRef.current) {
      undoStack.current.push(lastSnapshotRef.current);
      redoStack.current = [];
      lastSnapshotRef.current = val;
    }
  }, []);

  // ── Restore draft from localStorage on session switch ──
  // Skip when currentSessionId is null (initial mount before session is resolved)
  // to avoid clearing the textarea and causing a flicker.
  useEffect(() => {
    if (!state.currentSessionId) return;
    const el = inputRef.current;
    if (!el) return;
    const draft = loadDraft(state.currentSessionId);
    el.value = draft;
    lastSnapshotRef.current = draft;
    undoStack.current = [];
    redoStack.current = [];
    // Recalc height
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 210) + "px";
  }, [state.currentSessionId]);

  // ── Lazy command loading (gate on connected + empty commands) ──

  // ── Slash command autocomplete state ──
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFiltered, setSlashFiltered] = useState<SlashCommand[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);

  // ── @mention file autocomplete state ──
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const dropdownRef = useRef<HTMLDivElement>(null);

  const handleSend = useCallback(() => {
    const text = inputRef.current?.value.trim() ?? "";
    if (!text && images.length === 0 && files.length === 0) return;
    send(text, images.length > 0 ? images : undefined, files.length > 0 ? files : undefined);
    if (inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.style.height = "auto";
    }
    saveDraft(state.currentSessionId, "");
    lastSnapshotRef.current = "";
    undoStack.current = [];
    redoStack.current = [];
    setImages([]);
    setFiles([]);
    setSlashOpen(false);
    setMentionOpen(false);
  }, [send, images, files, state.currentSessionId]);

  // ── Detect slash commands and @mentions on input ──
  const slashAnchorRef = useRef(-1);
  const checkAutocomplete = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const val = el.value;
    const cursor = el.selectionStart ?? val.length;

    // Slash command: `/` preceded by whitespace or at start of input
    const textBeforeCursor = val.slice(0, cursor);
    const slashMatch = textBeforeCursor.match(/(^|[\s])\/([^\s]*)$/);
    if (slashMatch) {
      const query = slashMatch[2].toLowerCase();
      const filtered = state.commands.filter((c) =>
        c.name.toLowerCase().includes(query),
      );
      slashAnchorRef.current = textBeforeCursor.lastIndexOf("/");
      setSlashFiltered(filtered);
      setSlashOpen(filtered.length > 0);
      setSlashIdx(0);
      setMentionOpen(false);
      return;
    }
    setSlashOpen(false);
    slashAnchorRef.current = -1;

    // @mention: find `@` preceded by whitespace or at start
    const atMatch = textBeforeCursor.match(/(^|[\s])@([^\s]*)$/);
    if (atMatch) {
      const query = atMatch[2];
      // Debounce the file search
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        searchFiles(query, (results) => {
          setMentionResults(results);
          setMentionOpen(results.length > 0);
          setMentionIdx(0);
        });
      }, 150);
      return;
    }
    setMentionOpen(false);
  }, [state.commands, searchFiles]);

  // Clean up debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const selectSlashCommand = useCallback((cmd: SlashCommand) => {
    const el = inputRef.current;
    if (!el) return;
    const val = el.value;
    const cursor = el.selectionStart ?? val.length;
    const anchor = slashAnchorRef.current;
    if (anchor === -1) return;
    const before = val.slice(0, anchor);
    const after = val.slice(cursor);
    const replacement = `/${cmd.name} `;
    el.value = before + replacement + after;
    const newCursor = before.length + replacement.length;
    el.selectionStart = el.selectionEnd = newCursor;
    el.focus();
    setSlashOpen(false);
    slashAnchorRef.current = -1;
    // Trigger height recalc
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 210) + "px";
  }, []);

  const selectFile = useCallback((filePath: string) => {
    if (!inputRef.current) return;
    const val = inputRef.current.value;
    const cursor = inputRef.current.selectionStart ?? val.length;
    const textBeforeCursor = val.slice(0, cursor);
    // Remove the @query portion
    const atIdx = textBeforeCursor.lastIndexOf("@");
    if (atIdx === -1) return;
    const before = val.slice(0, atIdx);
    const after = val.slice(cursor);
    inputRef.current.value = before + after;
    inputRef.current.selectionStart = inputRef.current.selectionEnd = before.length;
    inputRef.current.focus();

    // Resolve to absolute path (cwd-relative)
    setFiles((prev) => {
      if (prev.some((f) => f.path === filePath)) return prev;
      return [...prev, { path: filePath, name: basename(filePath) }];
    });
    setMentionOpen(false);
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // ── Autocomplete keyboard navigation ──
      if (slashOpen && slashFiltered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIdx((i) => Math.min(i + 1, slashFiltered.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
          e.preventDefault();
          selectSlashCommand(slashFiltered[slashIdx]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashOpen(false);
          return;
        }
      }

      if (mentionOpen && mentionResults.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIdx((i) => Math.min(i + 1, mentionResults.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)) {
          e.preventDefault();
          selectFile(mentionResults[mentionIdx]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionOpen(false);
          return;
        }
      }

      // ── Undo / Redo ──
      if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        const el = inputRef.current;
        if (!el || undoStack.current.length === 0) return;
        redoStack.current.push(el.value);
        const prev = undoStack.current.pop()!;
        el.value = prev;
        lastSnapshotRef.current = prev;
        saveDraft(state.currentSessionId, prev);
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 210) + "px";
        return;
      }
      if (
        (e.key === "y" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) ||
        (e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey)
      ) {
        e.preventDefault();
        const el = inputRef.current;
        if (!el || redoStack.current.length === 0) return;
        undoStack.current.push(el.value);
        const next = redoStack.current.pop()!;
        el.value = next;
        lastSnapshotRef.current = next;
        saveDraft(state.currentSessionId, next);
        el.style.height = "auto";
        el.style.height = Math.min(el.scrollHeight, 210) + "px";
        return;
      }

      // ESC to interrupt when a turn is in progress
      if (e.key === "Escape" && state.busy) {
        e.preventDefault();
        interrupt();
        return;
      }

      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
      // Ctrl+V on Mac doesn't trigger native paste, so read clipboard manually
      if (e.key === "v" && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        navigator.clipboard.read().then((clipboardItems) => {
          for (const item of clipboardItems) {
            const imageType = item.types.find((t) => t.startsWith("image/"));
            if (!imageType) continue;
            item.getType(imageType).then((blob) => {
              toSupportedImage(blob).then((attachment) => {
                setImages((prev) => [...prev, attachment]);
              });
            });
          }
        }).catch(() => {
          // Clipboard API not available or permission denied; fall through
        });
      }
    },
    [handleSend, state.busy, state.currentSessionId, interrupt, slashOpen, slashFiltered, slashIdx, selectSlashCommand, mentionOpen, mentionResults, mentionIdx, selectFile],
  );

  const onInput = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    pushUndo();
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 210) + "px";
    saveDraft(state.currentSessionId, el.value);
    checkAutocomplete();
  }, [checkAutocomplete, pushUndo, state.currentSessionId]);

  const onFocus = useCallback(() => {
    if (state.commands.length === 0 && state.connected) {
      requestCommands();
    }
  }, [state.commands.length, state.connected, requestCommands]);

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        toSupportedImage(file).then((attachment) => {
          setImages((prev) => [...prev, attachment]);
        });
      }
    },
    [],
  );

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Auto-focus input on window focus and session switch
  useEffect(() => {
    const onWindowFocus = () => inputRef.current?.focus();
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, [state.currentSessionId]);

  // Scroll active dropdown item into view
  useEffect(() => {
    if (!dropdownRef.current) return;
    const active = dropdownRef.current.querySelector(".autocomplete-active");
    if (active) {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [slashIdx, mentionIdx, slashOpen, mentionOpen]);

  // Queued message entries for the pinned queue area — read directly from
  // pendingQueuedEntries (messages held out of the chat until agent picks them up).
  const queuedEntries = state.pendingQueuedEntries;

  const isSubagentView = state.currentSessionId?.includes(":subagent:") ?? false;

  if (isSubagentView) {
    return (
      <div className="border-t border-border px-5 py-3 shrink-0 flex items-center justify-center">
        <span className="text-xs text-dim">Read-only: viewing sub-agent session</span>
      </div>
    );
  }

  const showAutocomplete = slashOpen || mentionOpen;

  return (
    <div className="px-5 pb-8 shrink-0 relative">
      <div className="chat-content">
      {/* Pinned queued messages */}
      {queuedEntries.length > 0 && (
        <div className="queued-pin-area">
          {queuedEntries.map((entry) => {
            const text = entry.content
              .filter((b) => b.type === "text")
              .map((b) => (b as { text: string }).text)
              .join(" ");
            const truncated = text.length > 80 ? text.slice(0, 80) + "..." : text;
            return (
              <div key={entry.id} className="queued-pin-item">
                <span className="queued-pin-label">queued</span>
                <span className="queued-pin-text">{truncated || "..."}</span>
                <button
                  type="button"
                  className="queued-pin-cancel"
                  onClick={() => cancelQueued(entry._queueId!)}
                >
                  x
                </button>
              </div>
            );
          })}
        </div>
      )}
      {/* Autocomplete dropdown */}
      {showAutocomplete && (
        <div
          ref={dropdownRef}
          className="autocomplete-dropdown"
        >
          {slashOpen && slashFiltered.map((cmd, i) => (
            <div
              key={cmd.name}
              className={`autocomplete-item${i === slashIdx ? " autocomplete-active" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); selectSlashCommand(cmd); }}
              onMouseEnter={() => setSlashIdx(i)}
            >
              <span className="autocomplete-name">/{cmd.name}</span>
              {cmd.description && (
                <span className="autocomplete-desc">{cmd.description}</span>
              )}
            </div>
          ))}
          {mentionOpen && mentionResults.map((filePath, i) => (
            <div
              key={filePath}
              className={`autocomplete-item${i === mentionIdx ? " autocomplete-active" : ""}`}
              onMouseDown={(e) => { e.preventDefault(); selectFile(filePath); }}
              onMouseEnter={() => setMentionIdx(i)}
            >
              <span className="autocomplete-name">@{basename(filePath)}</span>
              <span className="autocomplete-desc">{filePath}</span>
            </div>
          ))}
        </div>
      )}
      {/* Attachment chips: images + files */}
      {(images.length > 0 || files.length > 0) && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {images.map((img, i) => (
            <div key={`img-${i}`} className="relative group">
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={`Pasted image ${i + 1}`}
                className="h-16 w-16 object-cover rounded-md border border-border"
              />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-600 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer border-none"
              >
                x
              </button>
            </div>
          ))}
          {files.map((file, i) => (
            <div key={`file-${file.path}`} className="file-chip group">
              <span className="file-chip-icon">@</span>
              <span className="file-chip-name" title={file.path}>{file.name}</span>
              <button
                type="button"
                onClick={() => removeFile(i)}
                className="file-chip-remove opacity-0 group-hover:opacity-100"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <textarea
          ref={inputRef}
          rows={3}
          placeholder={state.busy ? "Press ESC to interrupt..." : images.length > 0 ? "Add a message or send image..." : files.length > 0 ? "Add a message or send files..." : "Send a message... (/ for commands, @ for files)"}
          onKeyDown={onKeyDown}
          onInput={onInput}
          onPaste={onPaste}
          onFocus={onFocus}
          className="flex-1 bg-surface border-none rounded-[20px] p-[14px] text-text font-mono text-sm outline-none resize-none max-h-[210px] overflow-auto chat-input-shadow placeholder:text-dim"
        />

      </div>
      </div>
    </div>
  );
}
