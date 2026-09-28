import { describe, expect, it } from "vitest";
import { hasUnsavedChanges, initialSaveState, saveReducer, type SaveEvent, type SaveState } from "@/lib/autosave";
import { positionBetween } from "@/lib/data/pages";
import { containsSummary, replaceAiSections, summaryToNodes } from "@/lib/editor/summary-to-doc";
import { formatTimestamp, relativeTime, safeNextPath } from "@/lib/utils";
import { EMPTY_DOC, sanitizeDoc } from "@/lib/validation/content";
import type { StoredSummary } from "@/lib/validation/summary";
import type { RichTextDoc } from "@/types/models";

const run = (events: SaveEvent[], start: SaveState = initialSaveState(1)) => events.reduce(saveReducer, start);

describe("autosave state machine", () => {
  it("goes dirty -> saving -> saved", () => {
    const s = run([{ type: "edit" }, { type: "start" }, { type: "success", revision: 2 }]);
    expect(s).toMatchObject({ status: "saved", revision: 2 });
    expect(hasUnsavedChanges(s)).toBe(false);
  });

  it("queues edits made during a save and stays dirty afterwards", () => {
    const s = run([{ type: "edit" }, { type: "start" }, { type: "edit" }, { type: "success", revision: 2 }]);
    expect(s).toMatchObject({ status: "dirty", revision: 2, queued: false });
  });

  it("never reports saved before a save starts or after a failure", () => {
    expect(run([{ type: "success", revision: 9 }]).status).toBe("idle");
    const failed = run([{ type: "edit" }, { type: "start" }, { type: "failure", error: "offline" }]);
    expect(failed).toMatchObject({ status: "error", error: "offline", revision: 1 });
    expect(hasUnsavedChanges(failed)).toBe(true);
    expect(saveReducer(failed, { type: "start" }).status).toBe("saving"); // retry
  });

  it("blocks on conflict until resolved", () => {
    const c = run([{ type: "edit" }, { type: "start" }, { type: "conflict" }, { type: "edit" }, { type: "start" }]);
    expect(c.status).toBe("conflict");
    expect(saveReducer(c, { type: "resolved", revision: 5, dirty: true })).toMatchObject({ status: "dirty", revision: 5 });
  });
});

describe("sanitizeDoc", () => {
  it("keeps supported content untouched", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Hi", marks: [{ type: "bold" }] }] },
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph" }] }] },
      ],
    };
    expect(sanitizeDoc(doc)).toEqual({ doc, changed: false });
  });

  it("drops unknown nodes and unsafe links", () => {
    const { doc, changed } = sanitizeDoc({
      type: "doc",
      content: [
        { type: "script", content: [] },
        { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
      ],
    });
    expect(changed).toBe(true);
    expect(doc.content).toEqual([{ type: "paragraph", content: [{ type: "text", text: "x" }] }]);
  });

  it("falls back to an empty doc for invalid input", () => {
    expect(sanitizeDoc("<p>html</p>")).toEqual({ doc: EMPTY_DOC, changed: true });
    expect(sanitizeDoc(null)).toEqual({ doc: EMPTY_DOC, changed: false });
  });
});

const summary: StoredSummary = {
  overview: "Overview.",
  summary: "One.\n\nTwo.",
  keyPoints: ["A"],
  concepts: [{ name: "C", explanation: "E" }],
  keyMoments: [{ timestampSeconds: 83, title: "Moment", description: "D" }],
  takeaways: ["T"],
  revisionQuestions: [{ question: "Q?", answer: "A." }],
  timestampsAvailable: true,
};

describe("summary -> editor document", () => {
  it("creates tagged, valid sections with deep links", () => {
    const nodes = summaryToNodes(summary, "s1", "dQw4w9WgXcQ");
    expect(nodes.map((n) => n.attrs?.section)).toEqual(["overview", "summary", "keyPoints", "concepts", "keyMoments", "takeaways", "revisionQuestions"]);
    expect(JSON.stringify(nodes)).toContain("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=83s");
    expect(JSON.stringify(nodes)).toContain('"text":"1:23"');
    const doc = { type: "doc", content: nodes };
    expect(sanitizeDoc(doc).changed).toBe(false);
  });

  it("says timestamps are unavailable instead of inventing them", () => {
    const nodes = summaryToNodes({ ...summary, keyMoments: [], timestampsAvailable: false }, "s1", "dQw4w9WgXcQ");
    expect(JSON.stringify(nodes)).toContain("Timestamps are unavailable");
  });

  it("replaces only AI sections and keeps user notes in place", () => {
    const mine = { type: "paragraph", content: [{ type: "text", text: "my thoughts" }] };
    const after = { type: "paragraph", content: [{ type: "text", text: "after" }] };
    const doc: RichTextDoc = { type: "doc", content: [mine, ...summaryToNodes(summary, "old", "x"), after] };
    const next = replaceAiSections(doc, summaryToNodes(summary, "new", "x"));
    expect(next.content![0]).toEqual(mine);
    expect(next.content!.at(-1)).toEqual(after);
    expect(containsSummary(next, "new")).toBe(true);
    expect(containsSummary(next, "old")).toBe(false);
  });

  it("appends after user content when there were no AI sections", () => {
    const next = replaceAiSections(EMPTY_DOC, summaryToNodes(summary, "s", "x"));
    expect(next.content![0].type).toBe("aiSection");
    expect(next.content!.at(-1)).toEqual({ type: "paragraph" });
  });
});

describe("utilities", () => {
  it("computes fractional positions", () => {
    expect(positionBetween(null, null)).toBe(1);
    expect(positionBetween(1, 2)).toBe(1.5);
    expect(positionBetween(null, 1)).toBe(0);
    expect(positionBetween(3, null)).toBe(4);
  });

  it("formats timestamps", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(83)).toBe("1:23");
    expect(formatTimestamp(3725)).toBe("1:02:05");
  });

  it("only allows same-origin redirect paths", () => {
    expect(safeNextPath("/notebooks/1")).toBe("/notebooks/1");
    expect(safeNextPath("//evil.com")).toBe("/dashboard");
    expect(safeNextPath("/\\evil.com")).toBe("/dashboard");
    expect(safeNextPath("https://evil.com")).toBe("/dashboard");
    expect(safeNextPath(null)).toBe("/dashboard");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    expect(relativeTime("2026-01-10T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-01-10T10:00:00Z", now)).toBe("2 hours ago");
    expect(relativeTime("2026-01-09T12:00:00Z", now)).toBe("yesterday");
  });
});
