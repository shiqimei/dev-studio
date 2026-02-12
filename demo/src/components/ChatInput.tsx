import { useRef, useCallback, useState, useEffect } from "react";
import { useWs, titleLockedSessions } from "../context/WebSocketContext";
import { toSupportedImage } from "../utils";
import { RichTextEditor, type RichTextEditorHandle } from "./editor/RichTextEditor";
import { AutocompleteDropdown, type AutocompleteItem } from "./editor/AutocompleteDropdown";
import { detectTrigger, replaceTrigger, deleteTrigger, type TriggerMatch } from "./editor/autocomplete";
import type { ImageAttachment, FileAttachment, SlashCommand, ExecutorType } from "../types";

// ── Executor icons (base64 PNGs from ~/Downloads) ──

const CLAUDE_CODE_ICON = "data:image/png;base64,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";

const CODEX_ICON = "data:image/png;base64,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";

const EXECUTOR_META: Record<ExecutorType, { label: string; icon: string; description: string }> = {
  claude: { label: "Claude Code", icon: CLAUDE_CODE_ICON, description: "General-purpose coding" },
  codex: { label: "Codex", icon: CODEX_ICON, description: "Recommended for debugging" },
};

// ── localStorage helpers for session-scoped draft persistence ──
const DRAFT_KEY_PREFIX = "chatInput:draft:";
const CHAT_INPUT_MAX_HEIGHT_PX = 238; // 10 rows at 14px * 1.5 + 28px vertical padding

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
  const { state, send, deselectSession, searchFiles, requestCommands, preflightRoute, updatePendingPrompt, renameSession, dispatch } = useWs();
  const editorRef = useRef<RichTextEditorHandle>(null);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);

  // ── Backlog card editing ──
  // When the current session is a backlog card with a pending prompt,
  // we pre-populate the input and auto-sync edits back to the card title.
  const isBacklogEditRef = useRef(false);
  const renameDebouncerRef = useRef<ReturnType<typeof setTimeout>>();

  // ── Restore draft from localStorage on session switch ──
  // If the session has a pending prompt (backlog card), use that instead of
  // the localStorage draft so the user can continue editing the card title.
  useEffect(() => {
    if (!state.currentSessionId) return;
    const pendingPrompt = state.kanbanPendingPrompts[state.currentSessionId];
    const draft = pendingPrompt || loadDraft(state.currentSessionId);
    isBacklogEditRef.current = !!pendingPrompt;
    editorRef.current?.setMarkdown(draft);
  }, [state.currentSessionId]); // intentionally not depending on kanbanPendingPrompts to avoid re-running on every edit

  // ── Clear input when the current session's task starts (e.g. drag-to-in_progress) ──
  // The programmatic send() in handleMoveCard doesn't go through handleSend,
  // so the input wouldn't know to clear itself without this.
  const prevLiveStatusRef = useRef<string | undefined>();
  useEffect(() => {
    const sid = state.currentSessionId;
    if (!sid) return;
    const liveStatus = state.liveTurnStatus[sid]?.status;
    const prev = prevLiveStatusRef.current;
    prevLiveStatusRef.current = liveStatus;
    if (prev !== "in_progress" && liveStatus === "in_progress" && isBacklogEditRef.current) {
      isBacklogEditRef.current = false;
      if (renameDebouncerRef.current) clearTimeout(renameDebouncerRef.current);
      editorRef.current?.clear();
      saveDraft(sid, "");
    }
  }, [state.currentSessionId, state.liveTurnStatus]);

  // ── Slash command autocomplete state ──
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashFiltered, setSlashFiltered] = useState<SlashCommand[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);

  // ── @mention file autocomplete state ──
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Track the current trigger match for use in selection callbacks
  const triggerMatchRef = useRef<TriggerMatch | null>(null);

  // ── Executor popover state ──
  const [executorPopoverOpen, setExecutorPopoverOpen] = useState(false);
  const executorPopoverRef = useRef<HTMLDivElement>(null);
  const showExecutorSelector = state.availableExecutors.length > 1;

  useEffect(() => {
    if (!executorPopoverOpen) return;
    const handler = (e: MouseEvent) => {
      if (executorPopoverRef.current && !executorPopoverRef.current.contains(e.target as Node)) {
        setExecutorPopoverOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [executorPopoverOpen]);

  const handleSend = useCallback((markdown?: string) => {
    const text = (markdown ?? editorRef.current?.getMarkdown() ?? "").trim();
    if (!text && images.length === 0 && files.length === 0) return;

    // When sending from a backlog card, clear the pending prompt and lock the title
    // so the SDK doesn't overwrite it. The SEND_MESSAGE action will set liveTurnStatus
    // to in_progress, which triggers KanbanPanel's auto-clear to move the card.
    if (isBacklogEditRef.current && state.currentSessionId) {
      updatePendingPrompt(state.currentSessionId, "");
      titleLockedSessions.add(state.currentSessionId);
      setTimeout(() => titleLockedSessions.delete(state.currentSessionId!), 5000);
      isBacklogEditRef.current = false;
      if (renameDebouncerRef.current) clearTimeout(renameDebouncerRef.current);
    }

    send(text, images.length > 0 ? images : undefined, files.length > 0 ? files : undefined);
    editorRef.current?.clear();
    saveDraft(state.currentSessionId, "");
    setImages([]);
    setFiles([]);
    setSlashOpen(false);
    setMentionOpen(false);
  }, [send, images, files, state.currentSessionId, updatePendingPrompt]);

  // ── Detect slash commands and @mentions using the editor cursor ──
  const checkAutocomplete = useCallback(() => {
    const editor = editorRef.current?.getEditor();
    if (!editor) return;

    const match = detectTrigger(editor);
    triggerMatchRef.current = match;

    if (match?.trigger === "/") {
      const query = match.query.toLowerCase();
      const filtered = state.commands.filter((c) =>
        c.name.toLowerCase().includes(query),
      );
      setSlashFiltered(filtered);
      setSlashOpen(filtered.length > 0);
      setSlashIdx(0);
      setMentionOpen(false);
      return;
    }
    setSlashOpen(false);

    if (match?.trigger === "@") {
      // Debounce the file search
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        searchFiles(match.query, (results) => {
          setMentionResults(results);
          setMentionOpen(results.length > 0);
          setMentionIdx(0);
        });
      }, 150);
      return;
    }
    setMentionOpen(false);
  }, [state.commands, searchFiles]);

  // Clean up debounce timers on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (renameDebouncerRef.current) clearTimeout(renameDebouncerRef.current);
    };
  }, []);

  const selectSlashCommand = useCallback((cmd: SlashCommand) => {
    const editor = editorRef.current?.getEditor();
    const match = triggerMatchRef.current;
    if (!editor || !match) return;
    replaceTrigger(editor, match, `/${cmd.name} `);
    setSlashOpen(false);
    triggerMatchRef.current = null;
  }, []);

  const selectFile = useCallback((filePath: string) => {
    const editor = editorRef.current?.getEditor();
    const match = triggerMatchRef.current;
    if (!editor || !match) return;
    deleteTrigger(editor, match);

    // Resolve to absolute path (cwd-relative)
    setFiles((prev) => {
      if (prev.some((f) => f.path === filePath)) return prev;
      return [...prev, { path: filePath, name: basename(filePath) }];
    });
    setMentionOpen(false);
    triggerMatchRef.current = null;
  }, []);

  // ── Keyboard handler: intercept keys when autocomplete is open ──
  const onKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (slashOpen && slashFiltered.length > 0) {
        if (e.key === "ArrowDown") {
          setSlashIdx((i) => Math.min(i + 1, slashFiltered.length - 1));
          return true;
        }
        if (e.key === "ArrowUp") {
          setSlashIdx((i) => Math.max(i - 1, 0));
          return true;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.isComposing)) {
          selectSlashCommand(slashFiltered[slashIdx]);
          return true;
        }
        if (e.key === "Escape") {
          setSlashOpen(false);
          return true;
        }
      }

      if (mentionOpen && mentionResults.length > 0) {
        if (e.key === "ArrowDown") {
          setMentionIdx((i) => Math.min(i + 1, mentionResults.length - 1));
          return true;
        }
        if (e.key === "ArrowUp") {
          setMentionIdx((i) => Math.max(i - 1, 0));
          return true;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.isComposing)) {
          selectFile(mentionResults[mentionIdx]);
          return true;
        }
        if (e.key === "Escape") {
          setMentionOpen(false);
          return true;
        }
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

      return false;
    },
    [slashOpen, slashFiltered, slashIdx, selectSlashCommand, mentionOpen, mentionResults, mentionIdx, selectFile],
  );

  const onInput = useCallback((markdown: string) => {
    // When editing a backlog card, sync changes to the card title and pending prompt
    if (isBacklogEditRef.current && state.currentSessionId) {
      updatePendingPrompt(state.currentSessionId, markdown);
      // Optimistic title update in sidebar/kanban
      dispatch({ type: "SESSION_TITLE_UPDATE", sessionId: state.currentSessionId, title: markdown });
      // Debounced rename to persist on server
      if (renameDebouncerRef.current) clearTimeout(renameDebouncerRef.current);
      renameDebouncerRef.current = setTimeout(() => {
        if (state.currentSessionId) {
          renameSession(state.currentSessionId, markdown);
        }
      }, 300);
    } else {
      saveDraft(state.currentSessionId, markdown);
    }

    checkAutocomplete();
    // Trigger preflight session routing as user types (debounced internally)
    preflightRoute(markdown);
  }, [checkAutocomplete, state.currentSessionId, preflightRoute, updatePendingPrompt, renameSession, dispatch]);

  const onFocus = useCallback(() => {
    if (state.commands.length === 0 && state.connected) {
      requestCommands();
    }
  }, [state.commands.length, state.connected, requestCommands]);

  const onPaste = useCallback(
    (e: ClipboardEvent): boolean => {
      const items = e.clipboardData?.items;
      if (!items) return false;
      let handled = false;
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        handled = true;
        const file = item.getAsFile();
        if (!file) continue;
        toSupportedImage(file).then((attachment) => {
          setImages((prev) => [...prev, attachment]);
        });
      }
      return handled;
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
    const onWindowFocus = () => editorRef.current?.focus();
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, []);

  useEffect(() => {
    editorRef.current?.focus();
  }, [state.currentSessionId]);

  const isSubagentView = state.currentSessionId?.includes(":subagent:") ?? false;

  if (isSubagentView) {
    return (
      <div className="border-t border-border px-5 py-3 shrink-0 flex items-center justify-center">
        <span className="text-xs text-dim">Read-only: viewing sub-agent session</span>
      </div>
    );
  }

  const showAutocomplete = slashOpen || mentionOpen;

  // Map autocomplete state to shared dropdown items
  const autocompleteItems: AutocompleteItem[] = slashOpen
    ? slashFiltered.map((cmd) => ({ key: cmd.name, label: `/${cmd.name}`, description: cmd.description }))
    : mentionResults.map((filePath) => ({ key: filePath, label: `@${basename(filePath)}`, description: filePath }));
  const activeIdx = slashOpen ? slashIdx : mentionIdx;

  return (
    <div className="px-5 pb-8 shrink-0 relative">
      <div className="chat-content">
      {/* Autocomplete dropdown */}
      {showAutocomplete && (
        <AutocompleteDropdown
          items={autocompleteItems}
          activeIndex={activeIdx}
          onSelect={(i) => slashOpen ? selectSlashCommand(slashFiltered[i]) : selectFile(mentionResults[i])}
          onHover={(i) => slashOpen ? setSlashIdx(i) : setMentionIdx(i)}
        />
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
      <div className="relative">
        <RichTextEditor
          ref={editorRef}
          className="chat-input-editor"
          placeholder={images.length > 0 ? "Add a message or send image..." : files.length > 0 ? "Add a message or send files..." : "Send a message... (/ for commands, @ for files, ESC for new session)"}
          onSubmit={handleSend}
          onEscape={deselectSession}
          onInput={onInput}
          onFocus={onFocus}
          onPaste={onPaste}
          onKeyDown={onKeyDown}
          maxHeight={CHAT_INPUT_MAX_HEIGHT_PX}
          style={showExecutorSelector ? { paddingBottom: "42px" } : undefined}
        />
        {showExecutorSelector && (
          <div className="executor-selector-anchor" ref={executorPopoverRef}>
            <button
              type="button"
              className="executor-selector-trigger"
              onClick={() => setExecutorPopoverOpen((v) => !v)}
            >
              <img src={EXECUTOR_META[state.selectedExecutor].icon} width={18} height={18} alt="" />
              <span>{EXECUTOR_META[state.selectedExecutor].label}</span>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="executor-selector-chevron" style={executorPopoverOpen ? { transform: "rotate(180deg)" } : undefined}>
                <path d="M2.5 4L5 6.5L7.5 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {executorPopoverOpen && (
              <div className="executor-popover">
                {(["claude", "codex"] as ExecutorType[])
                  .filter((e) => state.availableExecutors.includes(e))
                  .map((e) => {
                    const meta = EXECUTOR_META[e];
                    const isActive = state.selectedExecutor === e;
                    return (
                      <button
                        key={e}
                        type="button"
                        className={`executor-popover-item${isActive ? " executor-popover-item-active" : ""}`}
                        onClick={() => {
                          dispatch({ type: "SET_EXECUTOR", executor: e });
                          setExecutorPopoverOpen(false);
                        }}
                      >
                        <span className="executor-popover-icon"><img src={meta.icon} width={24} height={24} alt="" /></span>
                        <span className="executor-popover-label">
                          <span className="executor-popover-name">{meta.label}</span>
                          <span className="executor-popover-desc">{meta.description}</span>
                        </span>
                        {isActive && (
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="executor-popover-check">
                            <path d="M3 7.5L5.5 10L11 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
              </div>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
