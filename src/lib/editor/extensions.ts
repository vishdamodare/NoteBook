import { Node, mergeAttributes, type Extensions } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";
import { SECTION_LABELS } from "./summary-to-doc";

/**
 * A container for AI-generated content. It keeps generated notes visually
 * distinct from the user's own writing, lets the user remove a whole section,
 * and lets "regenerate" replace only generated sections.
 */
export const AiSection = Node.create({
  name: "aiSection",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      section: { default: "notes" },
      summaryId: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: "section[data-ai-section]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["section", mergeAttributes(HTMLAttributes, { "data-ai-section": "" }), 0];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement("section");
      dom.className = "ai-section";
      dom.dataset.aiSection = node.attrs.section;

      const header = document.createElement("div");
      header.className = "ai-section-header";
      header.contentEditable = "false";
      const label = document.createElement("span");
      label.textContent = `AI generated · ${SECTION_LABELS[node.attrs.section as keyof typeof SECTION_LABELS] ?? "Notes"}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ai-section-remove";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${label.textContent} section`);
      remove.addEventListener("click", () => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (typeof pos !== "number" || !editor.isEditable) return;
        editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
      });
      header.append(label, remove);

      const contentDOM = document.createElement("div");
      contentDOM.className = "ai-section-content";
      dom.append(header, contentDOM);
      return { dom, contentDOM };
    };
  },
});

export function createExtensions(placeholder = "Start writing…"): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        openOnClick: false,
        autolink: true,
        defaultProtocol: "https",
        protocols: ["http", "https", "mailto"],
        HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
      },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Placeholder.configure({ placeholder }),
    AiSection,
  ];
}
