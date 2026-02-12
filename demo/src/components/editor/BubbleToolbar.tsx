import type { Editor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";

interface ToolbarButtonProps {
  onClick: () => void;
  isActive: boolean;
  title: string;
  children: React.ReactNode;
}

function ToolbarButton({ onClick, isActive, title, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      className={`bubble-toolbar-btn${isActive ? " active" : ""}`}
      onClick={onClick}
      title={title}
      onMouseDown={(e) => e.preventDefault()} // Prevent stealing focus
    >
      {children}
    </button>
  );
}

export function BubbleToolbar({ editor }: { editor: Editor }) {
  return (
    <BubbleMenu
      editor={editor}
      tippyOptions={{
        duration: 150,
        placement: "top",
        // Don't show for empty selections or code blocks
      }}
      shouldShow={({ state, from, to }) => {
        // Don't show if selection is empty
        if (from === to) return false;
        // Don't show inside code blocks
        const { $from } = state.selection;
        if ($from.parent.type.name === "codeBlock") return false;
        return true;
      }}
    >
      <div className="bubble-toolbar">
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive("bold")}
          title="Bold (Ctrl+B)"
        >
          <strong>B</strong>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive("italic")}
          title="Italic (Ctrl+I)"
        >
          <em>I</em>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleStrike().run()}
          isActive={editor.isActive("strike")}
          title="Strikethrough"
        >
          <s>S</s>
        </ToolbarButton>

        <span className="bubble-toolbar-divider" />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCode().run()}
          isActive={editor.isActive("code")}
          title="Inline Code (Ctrl+E)"
        >
          <code>&lt;/&gt;</code>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          isActive={editor.isActive("codeBlock")}
          title="Code Block"
        >
          <span style={{ fontFamily: "monospace", fontSize: 10 }}>{"{ }"}</span>
        </ToolbarButton>

        <span className="bubble-toolbar-divider" />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive("bulletList")}
          title="Bullet List"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="2.5" cy="4" r="1" fill="currentColor" />
            <circle cx="2.5" cy="7" r="1" fill="currentColor" />
            <circle cx="2.5" cy="10" r="1" fill="currentColor" />
            <line x1="5" y1="4" x2="12" y2="4" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive("orderedList")}
          title="Ordered List"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <text x="1" y="5.5" fill="currentColor" fontSize="5" fontFamily="monospace">1</text>
            <text x="1" y="8.5" fill="currentColor" fontSize="5" fontFamily="monospace">2</text>
            <text x="1" y="11.5" fill="currentColor" fontSize="5" fontFamily="monospace">3</text>
            <line x1="5" y1="4" x2="12" y2="4" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5" y1="7" x2="12" y2="7" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </ToolbarButton>

        <span className="bubble-toolbar-divider" />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          isActive={editor.isActive("blockquote")}
          title="Blockquote"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3L3 11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="6" y1="5" x2="12" y2="5" stroke="currentColor" strokeWidth="1.2" />
            <line x1="6" y1="7.5" x2="11" y2="7.5" stroke="currentColor" strokeWidth="1.2" />
            <line x1="6" y1="10" x2="9" y2="10" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </ToolbarButton>
      </div>
    </BubbleMenu>
  );
}
