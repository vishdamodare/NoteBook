// Converts a validated summary into TipTap JSON. Pure: shared by web and future mobile clients.
import { formatTimestamp } from "@/lib/utils";
import type { StoredSummary } from "@/lib/validation/summary";
import type { RichTextDoc, RichTextNode } from "@/types/models";

export const SECTION_LABELS = {
  overview: "Overview",
  summary: "Summary",
  keyPoints: "Key points",
  concepts: "Important concepts",
  keyMoments: "Key moments",
  takeaways: "Takeaways",
  revisionQuestions: "Revision questions",
} as const;

const text = (value: string, marks?: RichTextNode["marks"]): RichTextNode => ({ type: "text", text: value, ...(marks && { marks }) });
const paragraph = (...content: RichTextNode[]): RichTextNode => ({ type: "paragraph", content });
const heading = (value: string): RichTextNode => ({ type: "heading", attrs: { level: 2 }, content: [text(value)] });
const bullets = (items: RichTextNode[][]): RichTextNode => ({
  type: "bulletList",
  content: items.map((content) => ({ type: "listItem", content: [paragraph(...content)] })),
});
const bold = (value: string) => text(value, [{ type: "bold" }]);

function section(key: keyof typeof SECTION_LABELS, summaryId: string, body: RichTextNode[]): RichTextNode {
  return { type: "aiSection", attrs: { section: key, summaryId }, content: [heading(SECTION_LABELS[key]), ...body] };
}

export function summaryToNodes(summary: StoredSummary, summaryId: string, videoId: string): RichTextNode[] {
  const nodes: RichTextNode[] = [
    section("overview", summaryId, [paragraph(text(summary.overview))]),
    section(
      "summary",
      summaryId,
      summary.summary
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => paragraph(text(p))),
    ),
  ];
  if (summary.keyPoints.length) nodes.push(section("keyPoints", summaryId, [bullets(summary.keyPoints.map((p) => [text(p)]))]));
  if (summary.concepts.length) {
    nodes.push(section("concepts", summaryId, [bullets(summary.concepts.map((c) => [bold(c.name), text(` — ${c.explanation}`)]))]));
  }
  if (summary.keyMoments.length) {
    nodes.push(
      section("keyMoments", summaryId, [
        bullets(
          summary.keyMoments.map((m) => [
            text(formatTimestamp(m.timestampSeconds), [
              { type: "link", attrs: { href: `https://www.youtube.com/watch?v=${videoId}&t=${m.timestampSeconds}s` } },
            ]),
            text(" "),
            bold(m.title),
            ...(m.description ? [text(` — ${m.description}`)] : []),
          ]),
        ),
      ]),
    );
  } else if (!summary.timestampsAvailable) {
    nodes.push(
      section("keyMoments", summaryId, [
        paragraph(text("Timestamps are unavailable because the transcript has no timing information.", [{ type: "italic" }])),
      ]),
    );
  }
  if (summary.takeaways.length) nodes.push(section("takeaways", summaryId, [bullets(summary.takeaways.map((t) => [text(t)]))]));
  if (summary.revisionQuestions.length) {
    nodes.push(
      section("revisionQuestions", summaryId, [
        {
          type: "orderedList",
          content: summary.revisionQuestions.map((q) => ({
            type: "listItem",
            content: [paragraph(bold(q.question)), paragraph(text(q.answer, [{ type: "italic" }]))],
          })),
        },
      ]),
    );
  }
  return nodes;
}

export function hasAiSections(doc: RichTextDoc): boolean {
  return (doc.content ?? []).some((n) => n.type === "aiSection");
}

export function containsSummary(doc: RichTextDoc, summaryId: string): boolean {
  return (doc.content ?? []).some((n) => n.type === "aiSection" && n.attrs?.summaryId === summaryId);
}

const isEmptyParagraph = (n: RichTextNode) => n.type === "paragraph" && !n.content?.length;

/**
 * Replaces all AI sections with `nodes`, keeping every user-authored node
 * where it was. New sections go where the first old section was, or after the
 * user's content when there were none.
 */
export function replaceAiSections(doc: RichTextDoc, nodes: RichTextNode[]): RichTextDoc {
  const content = doc.content ?? [];
  const firstAi = content.findIndex((n) => n.type === "aiSection");
  const userNodes = content.filter((n) => n.type !== "aiSection");
  let next: RichTextNode[];
  if (firstAi >= 0) {
    const before = content.slice(0, firstAi).filter((n) => n.type !== "aiSection");
    const after = content.slice(firstAi).filter((n) => n.type !== "aiSection");
    next = [...before, ...nodes, ...after];
  } else {
    const trimmed = [...userNodes];
    while (trimmed.length && isEmptyParagraph(trimmed[trimmed.length - 1])) trimmed.pop();
    next = [...trimmed, ...nodes];
  }
  // Always leave a place for the user's own notes after the generated ones.
  if (!next.length || next[next.length - 1].type === "aiSection") next.push({ type: "paragraph" });
  return { type: "doc", content: next };
}
