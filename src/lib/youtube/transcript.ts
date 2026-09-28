import type { TranscriptSegment } from "@/types/models";

export type TranscriptErrorCode = "unavailable" | "rate_limited" | "provider_error";
export type TranscriptResult =
  | { ok: true; segments: TranscriptSegment[] }
  | { ok: false; code: TranscriptErrorCode; message: string };

/**
 * Source of transcripts for a YouTube video. Implementations must only use
 * sources you are licensed/permitted to use (e.g. a contracted transcript API,
 * or YouTube captions for videos the user owns via OAuth).
 *
 * No provider ships by default: YouTube's official captions API only serves
 * captions to the video owner, so for arbitrary videos the user pastes or
 * uploads the transcript instead. Register a provider in `getTranscriptProvider`.
 */
export interface TranscriptProvider {
  readonly name: string;
  fetchTranscript(videoId: string): Promise<TranscriptResult>;
}

export function getTranscriptProvider(): TranscriptProvider | null {
  return null;
}

// ---------------------------------------------------------------------------
// Pasted / uploaded transcripts
// ---------------------------------------------------------------------------

const CUE_TIMING = /^((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?)/;
const LEADING_TIME = /^\[?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d{1,3})?\]?(?:\s*[-–—:]\s*|\s+|$)(.*)$/;

/** "01:02:03,500" / "2:03" -> seconds */
export function parseClock(value: string): number {
  const parts = value.replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function cleanText(text: string): string {
  return text
    .replace(/<[^>]*>/g, "") // VTT styling tags such as <c> or <00:00:01.000>
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parses pasted transcript text into segments. Understands WebVTT, SRT,
 * "0:00 text" / "[00:00] text" lines, and plain text (no timestamps).
 */
export function parseTranscriptText(raw: string): TranscriptSegment[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;
  let sawTiming = false;

  const push = () => {
    if (current && current.text.trim()) segments.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (!sawTiming) push(); // blank lines separate plain-text paragraphs
      continue;
    }
    if (/^WEBVTT/.test(line) || /^(NOTE|STYLE|REGION)\b/.test(line)) continue;
    if (/^\d+$/.test(line) && CUE_TIMING.test(lines[i + 1]?.trim() ?? "")) continue; // SRT index

    const cue = CUE_TIMING.exec(line);
    if (cue) {
      push();
      sawTiming = true;
      const start = parseClock(cue[1]);
      current = { text: "", start, duration: Math.max(0, parseClock(cue[2]) - start) };
      continue;
    }

    const lead = LEADING_TIME.exec(line);
    if (lead) {
      push();
      sawTiming = true;
      current = { text: lead[2] ?? "", start: parseClock(lead[1]), duration: null };
      continue;
    }

    if (!current) current = { text: "", start: null, duration: null };
    current.text = current.text ? `${current.text} ${line}` : line;
  }
  push();
  return normalizeSegments(segments);
}

/**
 * Cleans segment text, drops empty segments and collapses the consecutive
 * duplicates produced by rolling auto-captions.
 */
export function normalizeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of segments) {
    const text = cleanText(seg.text);
    if (!text) continue;
    const start = typeof seg.start === "number" && Number.isFinite(seg.start) && seg.start >= 0 ? seg.start : null;
    const duration = typeof seg.duration === "number" && Number.isFinite(seg.duration) && seg.duration >= 0 ? seg.duration : null;
    if (out.length && out[out.length - 1].text === text) continue;
    out.push({ text, start, duration });
  }
  return out;
}

export function transcriptLength(segments: TranscriptSegment[]): number {
  return segments.reduce((n, s) => n + s.text.length + 1, 0);
}
