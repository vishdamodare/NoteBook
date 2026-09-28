import type { RichTextDoc, RichTextMark, RichTextNode } from "@/types/models";

// Every node/mark type the editor understands. Add new block types here when
// adding an editor extension; anything else is dropped on load.
const NODE_TYPES = new Set([
  "paragraph",
  "text",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "taskList",
  "taskItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "hardBreak",
  "aiSection",
]);
const MARK_TYPES = new Set(["bold", "italic", "underline", "strike", "code", "link"]);
const SAFE_HREF = /^(https?:|mailto:)/i;
const MAX_DEPTH = 40;

export const EMPTY_DOC: RichTextDoc = { type: "doc", content: [{ type: "paragraph" }] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanMarks(marks: unknown): RichTextMark[] | undefined {
  if (!Array.isArray(marks)) return undefined;
  const out = marks.filter((m): m is RichTextMark => {
    if (!isRecord(m) || typeof m.type !== "string" || !MARK_TYPES.has(m.type)) return false;
    if (m.type === "link") return isRecord(m.attrs) && typeof m.attrs.href === "string" && SAFE_HREF.test(m.attrs.href);
    return true;
  });
  return out.length ? out : undefined;
}

function cleanNode(node: unknown, depth: number): RichTextNode | null {
  if (!isRecord(node) || typeof node.type !== "string" || !NODE_TYPES.has(node.type) || depth > MAX_DEPTH) return null;
  if (node.type === "text") {
    if (typeof node.text !== "string" || node.text.length === 0) return null;
    return { type: "text", text: node.text, ...(cleanMarks(node.marks) && { marks: cleanMarks(node.marks) }) };
  }
  const out: RichTextNode = { type: node.type };
  if (isRecord(node.attrs)) out.attrs = node.attrs;
  if (Array.isArray(node.content)) {
    out.content = node.content.map((c) => cleanNode(c, depth + 1)).filter((c): c is RichTextNode => c !== null);
  }
  return out;
}

/**
 * Validates a stored document and drops anything the editor doesn't support
 * (unknown node types, unsafe link protocols). `changed` tells the caller
 * whether content was removed so it can warn the user.
 */
export function sanitizeDoc(value: unknown): { doc: RichTextDoc; changed: boolean } {
  if (!isRecord(value) || value.type !== "doc") return { doc: EMPTY_DOC, changed: value != null };
  const content = Array.isArray(value.content) ? value.content : [];
  const cleaned = content.map((c) => cleanNode(c, 1)).filter((c): c is RichTextNode => c !== null);
  const doc: RichTextDoc = { type: "doc", content: cleaned.length ? cleaned : EMPTY_DOC.content };
  return { doc, changed: JSON.stringify(doc.content) !== JSON.stringify(content.length ? content : EMPTY_DOC.content) };
}
