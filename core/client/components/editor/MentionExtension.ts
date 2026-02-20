import { Node, mergeAttributes } from "@tiptap/core";

export interface MentionNodeAttrs {
  /** Display label (e.g. "ci.yml", "Claude Code", "Codex"). */
  label: string;
  /** Underlying data (file path for files, executor key for executors). */
  id: string;
  /** Mention kind: "file" or "executor". */
  kind: "file" | "executor";
}

/**
 * Inline, atomic mention node rendered as a highlighted chip inside the editor.
 *
 * Serialized to markdown as `@label` so the server receives human-readable text.
 */
export const MentionNode = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      label: { default: "" },
      id: { default: "" },
      kind: { default: "file" },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-mention": "",
        "data-mention-kind": node.attrs.kind,
        class: "mention-node",
      }),
      `@${node.attrs.label}`,
    ];
  },

  // tiptap-markdown integration: serialize mention nodes as `@label`
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`@${node.attrs.label}`);
        },
        parse: {},
      },
    };
  },
});
