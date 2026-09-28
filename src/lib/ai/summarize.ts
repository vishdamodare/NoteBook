import { chunkNotesSchema, normalizeSummary, aiSummarySchema, type ChunkNotes, type StoredSummary } from "@/lib/validation/summary";
import { transcriptLength } from "@/lib/youtube/transcript";
import type { TranscriptSegment } from "@/types/models";
import type { AiProvider } from "./provider";
import { chunkPrompt, finalPrompt, reducePrompt } from "./prompts";

export class SummarizeError extends Error {
  constructor(
    readonly code: "transcript_too_long" | "invalid_output",
    message: string,
  ) {
    super(message);
  }
}

export interface SummarizeLimits {
  chunkChars: number;
  maxTranscriptChars: number;
}

/** Splits segments into consecutive chunks of at most `maxChars` (a single oversized segment is split by text). */
export function chunkSegments(segments: TranscriptSegment[], maxChars: number): TranscriptSegment[][] {
  const chunks: TranscriptSegment[][] = [];
  let current: TranscriptSegment[] = [];
  let size = 0;
  for (const seg of segments) {
    const pieces =
      seg.text.length <= maxChars
        ? [seg]
        : Array.from({ length: Math.ceil(seg.text.length / maxChars) }, (_, i) => ({
            ...seg,
            start: i === 0 ? seg.start : null,
            text: seg.text.slice(i * maxChars, (i + 1) * maxChars),
          }));
    for (const piece of pieces) {
      const len = piece.text.length + 16; // + timestamp marker
      if (size + len > maxChars && current.length) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(piece);
      size += len;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function validStarts(segments: TranscriptSegment[]): Set<number> {
  return new Set(segments.flatMap((s) => (s.start === null ? [] : [Math.floor(s.start)])));
}

async function generateValidated<T>(attempt: () => Promise<unknown>, validate: (raw: unknown) => T | null): Promise<T> {
  // One retry: models occasionally return malformed or empty output.
  for (let i = 0; i < 2; i++) {
    const result = validate(await attempt());
    if (result) return result;
  }
  throw new SummarizeError("invalid_output", "The AI returned notes we couldn't validate. Please try again.");
}

/**
 * Transcript -> validated StoredSummary. Short transcripts use one call; long
 * ones are summarised per chunk (map) and then combined (reduce), so each
 * piece of the transcript is sent to the model exactly once.
 */
export async function summarizeTranscript(
  provider: AiProvider,
  segments: TranscriptSegment[],
  title: string | null,
  limits: SummarizeLimits,
): Promise<StoredSummary> {
  if (transcriptLength(segments) > limits.maxTranscriptChars) {
    throw new SummarizeError("transcript_too_long", "This transcript is too long to summarise.");
  }
  const starts = validStarts(segments);
  const chunks = chunkSegments(segments, limits.chunkChars);

  if (chunks.length <= 1) {
    const prompt = finalPrompt(segments, title);
    return generateValidated(
      () => provider.generate({ schema: aiSummarySchema, name: "video_notes", ...prompt }),
      (raw) => normalizeSummary(raw, starts),
    );
  }

  const notes: ChunkNotes[] = [];
  for (const [i, chunk] of chunks.entries()) {
    const prompt = chunkPrompt(chunk, title, i, chunks.length);
    const chunkStarts = validStarts(chunk);
    notes.push(
      await generateValidated(
        () => provider.generate({ schema: chunkNotesSchema, name: "section_notes", ...prompt }),
        (raw) => {
          const parsed = chunkNotesSchema.safeParse(raw);
          if (!parsed.success || !parsed.data.summary.trim()) return null;
          return {
            ...parsed.data,
            keyMoments: parsed.data.keyMoments.filter((m) => chunkStarts.has(m.timestampSeconds)),
          };
        },
      ),
    );
  }

  const prompt = reducePrompt(notes, title);
  return generateValidated(
    () => provider.generate({ schema: aiSummarySchema, name: "video_notes", ...prompt }),
    (raw) => normalizeSummary(raw, starts),
  );
}
