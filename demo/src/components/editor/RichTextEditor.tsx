import { useEffect, useImperativeHandle, forwardRef, useRef, useCallback } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Extension } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import { BubbleToolbar } from "./BubbleToolbar";

export interface RichTextEditorHandle {
  focus: () => void;
  clear: () => void;
  getMarkdown: () => string;
  setMarkdown: (md: string) => void;
  isEmpty: () => boolean;
  /** Access the raw TipTap editor for autocomplete trigger detection, etc. */
  getEditor: () => import("@tiptap/core").Editor | null;
}

export interface RichTextEditorProps {
  /** Called on Enter (non-shift). Receives the markdown string. */
  onSubmit?: (markdown: string) => void;
  /** Called on Escape keypress. */
  onEscape?: () => void;
  /** Called on every content change with the markdown string. */
  onInput?: (markdown: string) => void;
  /** Called on focus. */
  onFocus?: () => void;
  /** Called on paste events — return true if handled. */
  onPaste?: (event: ClipboardEvent) => boolean;
  /** Called on blur. */
  onBlur?: () => void;
  /**
   * Called on keydown before the editor processes the key.
   * Return true to prevent the editor from handling it.
   */
  onKeyDown?: (event: KeyboardEvent) => boolean;
  placeholder?: string;
  /** Initial content as markdown string. */
  initialContent?: string;
  /** Max height in px for auto-resize. */
  maxHeight?: number;
  /** Additional CSS class for the editor wrapper. */
  className?: string;
  /** Additional inline styles for the editor wrapper. */
  style?: React.CSSProperties;
  /** Whether the editor is editable. */
  editable?: boolean;
}

/**
 * Custom extension to handle Enter-to-submit and Escape.
 */
function createKeyboardExtension(
  onSubmitRef: React.RefObject<((md: string) => void) | undefined>,
  onEscapeRef: React.RefObject<(() => void) | undefined>,
) {
  return Extension.create({
    name: "keyboardShortcuts",
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          // Don't intercept if composing (IME)
          if ((editor.view.dom.ownerDocument.defaultView as any)?.__imeComposing) return false;
          const fn = onSubmitRef.current;
          if (fn) {
            const md = (editor.storage.markdown?.getMarkdown?.() ?? editor.getText()).trim();
            fn(md);
            return true;
          }
          return false;
        },

        Escape: () => {
          const fn = onEscapeRef.current;
          if (fn) {
            fn();
            return true;
          }
          return false;
        },
      };
    },
  });
}

export const RichTextEditor = forwardRef<RichTextEditorHandle, RichTextEditorProps>(
  function RichTextEditor(
    {
      onSubmit,
      onEscape,
      onInput,
      onFocus,
      onPaste,
      onBlur,
      onKeyDown,
      placeholder: placeholderText,
      initialContent,
      maxHeight = 210,
      className,
      style,
      editable = true,
    },
    ref,
  ) {
    const onSubmitRef = useRef(onSubmit);
    onSubmitRef.current = onSubmit;
    const onEscapeRef = useRef(onEscape);
    onEscapeRef.current = onEscape;
    const onInputRef = useRef(onInput);
    onInputRef.current = onInput;
    const onPasteRef = useRef(onPaste);
    onPasteRef.current = onPaste;
    const onKeyDownRef = useRef(onKeyDown);
    onKeyDownRef.current = onKeyDown;

    // Ref for accessing the editor inside handleKeyDown (avoids circular dep)
    const editorInstanceRef = useRef<import("@tiptap/core").Editor | null>(null);

    const editor = useEditor({
      extensions: [
        StarterKit.configure({
          // Keep history (undo/redo) from StarterKit
          heading: { levels: [1, 2, 3] },
        }),
        Placeholder.configure({
          placeholder: placeholderText ?? "",
        }),
        Markdown.configure({
          html: false,
          transformPastedText: true,
          transformCopiedText: true,
        }),
        createKeyboardExtension(onSubmitRef, onEscapeRef),
      ],
      content: initialContent ? initialContent : "",
      editable,
      editorProps: {
        attributes: {
          class: "rich-text-editor-content",
          spellcheck: "true",
        },
        handleKeyDown: (_view, event) => {
          // Shift+Enter: since Enter is submit, Shift+Enter takes over Enter's
          // normal role — split list items inside lists, hard break elsewhere.
          if (event.key === "Enter" && event.shiftKey) {
            const ed = editorInstanceRef.current;
            if (ed) {
              if (ed.isActive("listItem")) {
                // Split the item; if it fails (empty item), lift out of the list
                if (!ed.commands.splitListItem("listItem")) {
                  ed.commands.liftListItem("listItem");
                }
              } else {
                // New paragraph (not hard break) so that input rules like
                // "- " and "1. " trigger at the start of the new block.
                ed.commands.splitBlock();
              }
              return true;
            }
          }
          const fn = onKeyDownRef.current;
          if (fn && fn(event)) return true;
          return false;
        },
        handlePaste: (_view, event) => {
          const fn = onPasteRef.current;
          if (fn && fn(event as unknown as ClipboardEvent)) {
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        onInputRef.current?.(ed.storage.markdown?.getMarkdown?.() ?? ed.getText());
      },
      onFocus: () => {
        onFocus?.();
      },
      onBlur: () => {
        onBlur?.();
      },
    });

    // Keep editor ref in sync for handleKeyDown access
    editorInstanceRef.current = editor;

    // Update placeholder when prop changes
    useEffect(() => {
      if (!editor) return;
      editor.extensionManager.extensions.forEach((ext) => {
        if (ext.name === "placeholder" && ext.options) {
          ext.options.placeholder = placeholderText ?? "";
          // Force ProseMirror to re-render decorations
          editor.view.dispatch(editor.state.tr);
        }
      });
    }, [editor, placeholderText]);

    // Update editable state
    useEffect(() => {
      if (editor) {
        editor.setEditable(editable);
      }
    }, [editor, editable]);

    // Expose imperative handle
    useImperativeHandle(
      ref,
      () => ({
        focus: () => editor?.commands.focus(),
        clear: () => {
          editor?.commands.clearContent();
        },
        getMarkdown: () => {
          return (editor?.storage.markdown?.getMarkdown?.() ?? editor?.getText() ?? "").trim();
        },
        setMarkdown: (md: string) => {
          if (!editor) return;
          editor.commands.setContent(md);
        },
        isEmpty: () => editor?.isEmpty ?? true,
        getEditor: () => editor ?? null,
      }),
      [editor],
    );

    // Auto-resize: cap at maxHeight
    const wrapperRef = useRef<HTMLDivElement>(null);
    const updateHeight = useCallback(() => {
      const el = wrapperRef.current;
      if (!el) return;
      const prosemirror = el.querySelector(".ProseMirror") as HTMLElement | null;
      if (!prosemirror) return;
      prosemirror.style.maxHeight = `${maxHeight}px`;
      prosemirror.style.overflowY = "auto";
    }, [maxHeight]);

    useEffect(() => {
      updateHeight();
    }, [updateHeight]);

    // Re-run height calc on content changes
    useEffect(() => {
      if (!editor) return;
      const handler = () => updateHeight();
      editor.on("update", handler);
      return () => {
        editor.off("update", handler);
      };
    }, [editor, updateHeight]);

    return (
      <div ref={wrapperRef} className={`rich-text-editor ${className ?? ""}`} style={style}>
        {editor && <BubbleToolbar editor={editor} />}
        <EditorContent editor={editor} />
      </div>
    );
  },
);
