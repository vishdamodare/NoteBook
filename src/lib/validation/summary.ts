import { z } from "zod";

// Shape requested from the model. Kept constraint-free so it is accepted by
// strict structured-output modes; all real limits are enforced by
// `normalizeSummary` below before anything is saved.
export const aiSummarySchema = z.object({
  overview: z.string(),
  summary: z.string(),
  keyPoints: z.array(z.string()),
  concepts: z.array(z.object({ name: z.string(), explanation: z.string() })),
  keyMoments: z.array(z.object({ timestampSeconds: z.number(), title: z.string(), description: z.string() })),
  takeaways: z.array(z.string()),
  revisionQuestions: z.array(z.object({ question: z.string(), answer: z.string() })),
});
export type AiSummary = z.infer<typeof aiSummarySchema>;

// Intermediate notes for one chunk of a long transcript.
export const chunkNotesSchema = z.object({
  summary: z.string(),
  keyPoints: z.array(z.string()),
  concepts: z.array(z.object({ name: z.string(), explanation: z.string() })),
  keyMoments: z.array(z.object({ timestampSeconds: z.number(), title: z.string(), description: z.string() })),
});
export type ChunkNotes = z.infer<typeof chunkNotesSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);

// What is stored in summaries.summary_json.
export const storedSummarySchema = z.object({
  overview: text(2000),
  summary: text(12000),
  keyPoints: z.array(text(600)).max(20),
  concepts: z.array(z.object({ name: text(200), explanation: text(1200) })).max(20),
  keyMoments: z
    .array(z.object({ timestampSeconds: z.number().int().nonnegative(), title: text(200), description: z.string().trim().max(800) }))
    .max(30),
  takeaways: z.array(text(600)).max(15),
  revisionQuestions: z.array(z.object({ question: text(500), answer: text(1500) })).max(15),
  timestampsAvailable: z.boolean(),
});
export type StoredSummary = z.infer<typeof storedSummarySchema>;

const clip = (s: unknown, max: number) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const nonEmpty = (s: string) => s.length > 0;

/**
 * Validates untrusted model output and normalises it into a StoredSummary.
 * Key moments are kept only when their timestamp exactly matches a segment
 * start from the transcript (the model is shown those values), so no
 * timestamp is ever invented. Returns null when the output is unusable.
 */
export function normalizeSummary(raw: unknown, validStarts: ReadonlySet<number>): StoredSummary | null {
  const parsed = aiSummarySchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  const candidate = {
    overview: clip(s.overview, 2000),
    summary: clip(s.summary, 12000),
    keyPoints: s.keyPoints.map((p) => clip(p, 600)).filter(nonEmpty).slice(0, 20),
    concepts: s.concepts
      .map((c) => ({ name: clip(c.name, 200), explanation: clip(c.explanation, 1200) }))
      .filter((c) => c.name && c.explanation)
      .slice(0, 20),
    keyMoments: s.keyMoments
      .filter((m) => Number.isInteger(m.timestampSeconds) && validStarts.has(m.timestampSeconds))
      .map((m) => ({ timestampSeconds: m.timestampSeconds, title: clip(m.title, 200), description: clip(m.description, 800) }))
      .filter((m) => m.title)
      .sort((a, b) => a.timestampSeconds - b.timestampSeconds)
      .filter((m, i, all) => i === 0 || all[i - 1].timestampSeconds !== m.timestampSeconds)
      .slice(0, 30),
    takeaways: s.takeaways.map((t) => clip(t, 600)).filter(nonEmpty).slice(0, 15),
    revisionQuestions: s.revisionQuestions
      .map((q) => ({ question: clip(q.question, 500), answer: clip(q.answer, 1500) }))
      .filter((q) => q.question && q.answer)
      .slice(0, 15),
    timestampsAvailable: validStarts.size > 0,
  };
  const result = storedSummarySchema.safeParse(candidate);
  return result.success ? result.data : null;
}
