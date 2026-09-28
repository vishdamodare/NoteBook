import { describe, expect, it, vi } from "vitest";
import { fetchVideoMetadata, parseIsoDuration } from "@/lib/youtube/metadata";
import { normalizeSegments, parseClock, parseTranscriptText } from "@/lib/youtube/transcript";
import { parseYouTubeUrl } from "@/lib/youtube/url";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeUrl", () => {
  it.each([
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&list=PL123`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?si=abc`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `youtube.com/watch?v=${ID}`,
    `  https://YOUTU.BE/${ID}  `,
  ])("accepts %s", (input) => {
    expect(parseYouTubeUrl(input)).toEqual({ ok: true, videoId: ID, url: `https://www.youtube.com/watch?v=${ID}` });
  });

  it.each([
    "",
    "not a url",
    `https://evil.com/watch?v=${ID}`,
    `https://youtube.com.evil.com/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=short`,
    `https://www.youtube.com/watch?v=${ID}xx`,
    `https://www.youtube.com/channel/UC123`,
    `javascript:alert(1)//youtube.com/watch?v=${ID}`,
    `ftp://youtube.com/watch?v=${ID}`,
    `https://user:pass@youtube.com/watch?v=${ID}`,
    `https://youtube.com:8443/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${"a".repeat(3000)}`,
  ])("rejects %s", (input) => {
    expect(parseYouTubeUrl(input).ok).toBe(false);
  });
});

describe("parseIsoDuration", () => {
  it("parses YouTube ISO 8601 durations", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("PT45S")).toBe(45);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
    expect(parseIsoDuration("PT")).toBeNull();
    expect(parseIsoDuration("garbage")).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });
});

describe("fetchVideoMetadata", () => {
  const json = (status: number, body: unknown) =>
    vi.fn(async (_url: string) => new Response(JSON.stringify(body), { status }));

  it("uses oEmbed without an API key and only contacts YouTube", async () => {
    const fetchImpl = json(200, { title: "Lecture 1", author_name: "MIT", thumbnail_url: "https://i.ytimg.com/x.jpg" });
    const result = await fetchVideoMetadata(ID, { fetchImpl });
    expect(result).toEqual({
      ok: true,
      metadata: { title: "Lecture 1", channelName: "MIT", thumbnailUrl: "https://i.ytimg.com/x.jpg", durationSeconds: null, description: null },
    });
    expect(new URL(fetchImpl.mock.calls[0][0]).hostname).toBe("www.youtube.com");
  });

  it("uses the Data API with a key", async () => {
    const fetchImpl = json(200, {
      items: [{ snippet: { title: "T", channelTitle: "C", description: "D", thumbnails: { high: { url: "https://i/h.jpg" } } }, contentDetails: { duration: "PT10M" } }],
    });
    const result = await fetchVideoMetadata(ID, { apiKey: "k", fetchImpl });
    expect(result).toMatchObject({ ok: true, metadata: { title: "T", channelName: "C", durationSeconds: 600, description: "D" } });
    expect(new URL(fetchImpl.mock.calls[0][0]).hostname).toBe("www.googleapis.com");
  });

  it("reports unavailable, private and rate-limited videos without inventing data", async () => {
    expect(await fetchVideoMetadata(ID, { fetchImpl: json(404, {}) })).toMatchObject({ ok: false, code: "not_found" });
    expect(await fetchVideoMetadata(ID, { fetchImpl: json(401, {}) })).toMatchObject({ ok: false, code: "private" });
    expect(await fetchVideoMetadata(ID, { fetchImpl: json(429, {}) })).toMatchObject({ ok: false, code: "rate_limited" });
    expect(await fetchVideoMetadata(ID, { apiKey: "k", fetchImpl: json(200, { items: [] }) })).toMatchObject({ ok: false, code: "not_found" });
    const throwing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchVideoMetadata(ID, { fetchImpl: throwing })).toMatchObject({ ok: false, code: "provider_error" });
  });

  it("refuses invalid IDs without making a request", async () => {
    const fetchImpl = json(200, {});
    expect(await fetchVideoMetadata("../../etc", { fetchImpl })).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("transcript parsing", () => {
  it("parses clock values", () => {
    expect(parseClock("1:02:03,500")).toBe(3723.5);
    expect(parseClock("02:03")).toBe(123);
  });

  it("parses WebVTT and collapses rolling duplicates", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello <c>world</c>

00:00:04.000 --> 00:00:06.500
Hello world

00:00:06.500 --> 00:00:09.000
Second &amp; line`;
    expect(parseTranscriptText(vtt)).toEqual([
      { text: "Hello world", start: 1, duration: 3 },
      { text: "Second & line", start: 6.5, duration: 2.5 },
    ]);
  });

  it("parses SRT", () => {
    const srt = `1
00:00:00,000 --> 00:00:02,000
First line
continues

2
00:01:00,000 --> 00:01:05,000
Second`;
    expect(parseTranscriptText(srt)).toEqual([
      { text: "First line continues", start: 0, duration: 2 },
      { text: "Second", start: 60, duration: 5 },
    ]);
  });

  it("parses leading timestamp lines", () => {
    expect(parseTranscriptText("0:00 Intro\n[1:05] Main idea\n1:02:03 - Wrap up")).toEqual([
      { text: "Intro", start: 0, duration: null },
      { text: "Main idea", start: 65, duration: null },
      { text: "Wrap up", start: 3723, duration: null },
    ]);
  });

  it("treats text without timestamps as untimed paragraphs", () => {
    expect(parseTranscriptText("Para one\nstill one\n\nPara two")).toEqual([
      { text: "Para one still one", start: null, duration: null },
      { text: "Para two", start: null, duration: null },
    ]);
    expect(parseTranscriptText("   \n\n ")).toEqual([]);
  });

  it("normalizes provider segments defensively", () => {
    expect(
      normalizeSegments([
        { text: "  a  ", start: -1, duration: Number.NaN },
        { text: "", start: 2, duration: 1 },
      ]),
    ).toEqual([{ text: "a", start: null, duration: null }]);
  });
});
