import { useRef, useCallback, useState, useEffect } from "react";
import { useWs, titleLockedSessions } from "../context/WebSocketContext";
import { toSupportedImage } from "../utils";
import { RichTextEditor, type RichTextEditorHandle } from "./editor/RichTextEditor";
import { AutocompleteDropdown, type AutocompleteItem } from "./editor/AutocompleteDropdown";
import { detectTrigger, replaceTrigger, type TriggerMatch } from "./editor/autocomplete";
import type { ImageAttachment, FileAttachment, SlashCommand, ExecutorType } from "../types";
import { CLAUDE_CODE_ICON, CODEX_ICON } from "../executor-icons";

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

/**
 * Scan text for executor mentions (`@claude code`, `@codex`).
 * When multiple mentions exist, return the one that appears last.
 */
function detectExecutorMention(text: string, available: ExecutorType[]): ExecutorType | null {
  const patterns: { pattern: RegExp; executor: ExecutorType }[] = [
    { pattern: /@claude\s+code/gi, executor: "claude" },
    { pattern: /@codex/gi, executor: "codex" },
  ];

  let latest: ExecutorType | null = null;
  let latestIndex = -1;

  for (const { pattern, executor } of patterns) {
    if (!available.includes(executor)) continue;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > latestIndex) {
        latestIndex = match.index;
        latest = executor;
      }
    }
  }

  return latest;
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
  // Ref for executor candidates so the keyboard handler can access them without stale closures
  const executorCandidatesRef = useRef<{ key: string; executor: ExecutorType }[]>([]);

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
      // Check if any executor candidates match the query — open immediately if so
      const q = match.query.toLowerCase();
      const hasExecMatch = state.availableExecutors.some((e) => {
        const label = EXECUTOR_META[e].label.toLowerCase();
        return label.includes(q) || e.includes(q);
      });
      if (hasExecMatch) {
        setMentionOpen(true);
        setMentionIdx(0);
      }

      // Debounce the file search
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        searchFiles(match.query, (results) => {
          setMentionResults(results);
          setMentionOpen(results.length > 0 || hasExecMatch);
          setMentionIdx(0);
        });
      }, 150);
      return;
    }
    setMentionOpen(false);
  }, [state.commands, searchFiles, state.availableExecutors]);

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

    // Replace the @query with an inline mention node
    editor
      .chain()
      .focus()
      .deleteRange({ from: match.from, to: match.to })
      .insertContent({
        type: "mention",
        attrs: { label: basename(filePath), id: filePath, kind: "file" },
      })
      .insertContent(" ")
      .run();

    // Also track the file in the attachments array for sending
    setFiles((prev) => {
      if (prev.some((f) => f.path === filePath)) return prev;
      return [...prev, { path: filePath, name: basename(filePath) }];
    });
    setMentionOpen(false);
    triggerMatchRef.current = null;
  }, []);

  const selectExecutorMention = useCallback((executor: ExecutorType) => {
    const editor = editorRef.current?.getEditor();
    const match = triggerMatchRef.current;
    if (!editor || !match) return;

    const meta = EXECUTOR_META[executor];

    // Replace the @query with an inline mention node and trailing space
    // in one transaction so Tab completion always leaves a separator.
    editor
      .chain()
      .focus()
      .deleteRange({ from: match.from, to: match.to })
      .insertContent([
        {
          type: "mention",
          attrs: { label: meta.label, id: executor, kind: "executor" },
        },
        { type: "text", text: " " },
      ])
      .run();

    // Switch the executor selector
    dispatch({ type: "SET_EXECUTOR", executor });
    setMentionOpen(false);
    triggerMatchRef.current = null;
  }, [dispatch]);

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

      if (mentionOpen && (mentionResults.length > 0 || executorCandidatesRef.current.length > 0)) {
        const totalItems = executorCandidatesRef.current.length + mentionResults.length;
        if (e.key === "ArrowDown") {
          setMentionIdx((i) => Math.min(i + 1, totalItems - 1));
          return true;
        }
        if (e.key === "ArrowUp") {
          setMentionIdx((i) => Math.max(i - 1, 0));
          return true;
        }
        if (e.key === "Tab" || (e.key === "Enter" && !e.isComposing)) {
          const execCount = executorCandidatesRef.current.length;
          if (mentionIdx < execCount) {
            selectExecutorMention(executorCandidatesRef.current[mentionIdx].executor);
          } else {
            selectFile(mentionResults[mentionIdx - execCount]);
          }
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
    [slashOpen, slashFiltered, slashIdx, selectSlashCommand, mentionOpen, mentionResults, mentionIdx, selectFile, selectExecutorMention],
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

    // Detect executor mentions (@claude code, @codex) and switch the selector
    const mentionedExecutor = detectExecutorMention(markdown, state.availableExecutors);
    if (mentionedExecutor && mentionedExecutor !== state.selectedExecutor) {
      dispatch({ type: "SET_EXECUTOR", executor: mentionedExecutor });
    }

    checkAutocomplete();
    // Trigger preflight session routing as user types (debounced internally)
    preflightRoute(markdown);
  }, [checkAutocomplete, state.currentSessionId, state.selectedExecutor, state.availableExecutors, preflightRoute, updatePendingPrompt, renameSession, dispatch]);

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

  // Build executor candidates that match the current @query
  const mentionQuery = triggerMatchRef.current?.trigger === "@" ? triggerMatchRef.current.query.toLowerCase() : "";
  const executorCandidates: { key: string; executor: ExecutorType }[] = mentionOpen
    ? (["claude", "codex"] as ExecutorType[])
        .filter((e) => state.availableExecutors.includes(e))
        .filter((e) => {
          const label = EXECUTOR_META[e].label.toLowerCase();
          return label.includes(mentionQuery) || e.includes(mentionQuery);
        })
        .map((e) => ({ key: `executor:${e}`, executor: e }))
    : [];
  executorCandidatesRef.current = executorCandidates;

  // Map autocomplete state to shared dropdown items
  // Executor candidates appear at the top, then file results below
  const autocompleteItems: AutocompleteItem[] = slashOpen
    ? slashFiltered.map((cmd) => ({ key: cmd.name, label: `/${cmd.name}`, description: cmd.description }))
    : [
        ...executorCandidates.map(({ key, executor }) => ({
          key,
          label: `@${EXECUTOR_META[executor].label}`,
          description: EXECUTOR_META[executor].description,
        })),
        ...mentionResults.map((filePath) => ({
          key: filePath,
          label: `@${basename(filePath)}`,
          description: filePath,
        })),
      ];
  const activeIdx = slashOpen ? slashIdx : mentionIdx;

  return (
    <div className="px-5 pb-8 shrink-0 relative">
      <div className="chat-content">
      {/* Autocomplete dropdown */}
      {showAutocomplete && (
        <AutocompleteDropdown
          items={autocompleteItems}
          activeIndex={activeIdx}
          onSelect={(i) => {
            if (slashOpen) return selectSlashCommand(slashFiltered[i]);
            // Check if this index corresponds to an executor candidate
            if (i < executorCandidates.length) {
              return selectExecutorMention(executorCandidates[i].executor);
            }
            selectFile(mentionResults[i - executorCandidates.length]);
          }}
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
