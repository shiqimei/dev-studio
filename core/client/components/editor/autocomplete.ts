import type { Editor } from "@tiptap/core";

export interface TriggerMatch {
  trigger: "/" | "@";
  query: string;
  /** ProseMirror position of the trigger character. */
  from: number;
  /** ProseMirror position of the cursor (end of query). */
  to: number;
}

/**
 * Detect a `/` or `@` trigger in the current text block before the cursor.
 * Returns null if no trigger is active.
 */
export function detectTrigger(editor: Editor): TriggerMatch | null {
  const { $from } = editor.state.selection;
  const textBeforeCursor = $from.parent.textBetween(0, $from.parentOffset, "\0");
  const blockStart = $from.pos - $from.parentOffset;

  // Slash command: `/` preceded by whitespace or at start of block
  const slashMatch = textBeforeCursor.match(/(^|[\s])\/([^\s]*)$/);
  if (slashMatch) {
    const triggerOffset = textBeforeCursor.lastIndexOf("/");
    return {
      trigger: "/",
      query: slashMatch[2],
      from: blockStart + triggerOffset,
      to: $from.pos,
    };
  }

  // @mention: `@` preceded by whitespace or at start of block
  const atMatch = textBeforeCursor.match(/(^|[\s])@([^\s]*)$/);
  if (atMatch) {
    const triggerOffset = textBeforeCursor.lastIndexOf("@");
    return {
      trigger: "@",
      query: atMatch[2],
      from: blockStart + triggerOffset,
      to: $from.pos,
    };
  }

  return null;
}

/**
 * Replace the trigger text (from trigger char to cursor) with the given content.
 */
export function replaceTrigger(editor: Editor, match: TriggerMatch, replacement: string): void {
  editor.chain().focus().deleteRange({ from: match.from, to: match.to }).insertContent(replacement).run();
}

/**
 * Delete the trigger text without inserting anything (used for @mentions
 * where the file is added to an attachments array instead of inline text).
 */
export function deleteTrigger(editor: Editor, match: TriggerMatch): void {
  editor.chain().focus().deleteRange({ from: match.from, to: match.to }).run();
}
