import { describe, expect, it, vi } from "vitest";
import { AiError, type AiProvider } from "@/lib/ai/provider";
import { runProcessingJob, type JobPatch, type PipelineDeps, type PipelineVideo, type VideoPatch } from "@/lib/jobs/pipeline";
import type { TranscriptProvider } from "@/lib/youtube/transcript";

const summary = {
  overview: "O",
  summary: "S",
  keyPoints: ["k"],
  concepts: [],
  keyMoments: [{ timestampSeconds: 0, title: "Start", description: "" }],
  takeaways: [],
  revisionQuestions: [],
};

function setup(overrides: Partial<PipelineDeps> = {}) {
  const jobPatches: JobPatch[] = [];
  const videoPatches: VideoPatch[] = [];
  const summaries: unknown[] = [];
  const deps: PipelineDeps = {
    repo: {
      updateJob: vi.fn(async (_id, patch) => void jobPatches.push(patch)),
      updateVideo: vi.fn(async (_id, patch) => void videoPatches.push(patch)),
      insertSummary: vi.fn(async (row) => (summaries.push(row), { id: "summary-1" })),
    },
    fetchMetadata: vi.fn(async () => ({
      ok: true as const,
      metadata: { title: "Video", channelName: "Chan", thumbnailUrl: null, durationSeconds: null, description: null },
    })),
    transcriptProvider: null,
    createAi: () => ({ model: "m", generate: vi.fn(async () => summary) }) as AiProvider,
    limits: { chunkChars: 10_000, maxTranscriptChars: 100_000 },
    ...overrides,
  };
  return { deps, jobPatches, videoPatches, summaries, statuses: () => jobPatches.flatMap((p) => (p.status ? [p.status] : [])) };
}

const video = (over: Partial<PipelineVideo> = {}): PipelineVideo => ({
  id: "v1",
  video_id: "dQw4w9WgXcQ",
  video_title: null,
  metadata_status: "pending",
  transcript_segments: [{ text: "Hello", start: 0, duration: 2 }],
  ...over,
});

describe("runProcessingJob", () => {
  it("walks through every state and saves a validated summary", async () => {
    const t = setup();
    expect(await runProcessingJob({ id: "j", attempts: 0 }, video(), t.deps)).toBe("completed");
    expect(t.statuses()).toEqual(["fetching_metadata", "fetching_transcript", "processing", "completed"]);
    expect(t.jobPatches[0].attempts).toBe(1);
    expect(t.jobPatches.at(-1)).toMatchObject({ summary_id: "summary-1" });
    expect(t.summaries[0]).toMatchObject({ model: "m", summary_json: { overview: "O", timestampsAvailable: true } });
    expect(t.videoPatches[0]).toMatchObject({ video_title: "Video", metadata_status: "available" });
  });

  it("fails with a paste-transcript message when no transcript is available", async () => {
    const t = setup();
    expect(await runProcessingJob({ id: "j", attempts: 0 }, video({ transcript_segments: null }), t.deps)).toBe("failed");
    expect(t.statuses()).toEqual(["fetching_metadata", "fetching_transcript", "failed"]);
    expect(t.jobPatches.at(-1)).toMatchObject({ error_code: "transcript_unavailable", error_message: expect.stringMatching(/paste/i) });
    expect(t.videoPatches).toContainEqual({ transcript_status: "unavailable" });
    expect(t.summaries).toHaveLength(0);
  });

  it("uses a transcript provider when configured", async () => {
    const provider: TranscriptProvider = {
      name: "fake",
      fetchTranscript: async () => ({ ok: true, segments: [{ text: " From provider ", start: 0, duration: null }] }),
    };
    const t = setup({ transcriptProvider: provider });
    expect(await runProcessingJob({ id: "j", attempts: 0 }, video({ transcript_segments: null }), t.deps)).toBe("completed");
    expect(t.videoPatches).toContainEqual({
      transcript_segments: [{ text: "From provider", start: 0, duration: null }],
      transcript_status: "available",
      transcript_source: "provider",
    });
  });

  it("continues when metadata is unavailable (e.g. private video with pasted transcript)", async () => {
    const t = setup({ fetchMetadata: async () => ({ ok: false, code: "private", message: "private" }) });
    expect(await runProcessingJob({ id: "j", attempts: 2 }, video(), t.deps)).toBe("completed");
    expect(t.videoPatches[0]).toEqual({ metadata_status: "unavailable" });
    expect(t.jobPatches[0].attempts).toBe(3);
  });

  it("skips the metadata fetch when it is already stored", async () => {
    const t = setup();
    await runProcessingJob({ id: "j", attempts: 0 }, video({ metadata_status: "available" }), t.deps);
    expect(t.deps.fetchMetadata).not.toHaveBeenCalled();
  });

  it("reports AI configuration and provider errors without leaking internals", async () => {
    const t = setup({
      createAi: () => {
        throw new AiError("not_configured", "AI summaries aren't configured.");
      },
    });
    expect(await runProcessingJob({ id: "j", attempts: 0 }, video(), t.deps)).toBe("failed");
    expect(t.jobPatches.at(-1)).toMatchObject({ status: "failed", error_code: "not_configured" });

    const crash = setup({ createAi: () => ({ model: "m", generate: async () => { throw new Error("secret stack detail"); } }) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runProcessingJob({ id: "j", attempts: 0 }, video(), crash.deps);
    spy.mockRestore();
    expect(crash.jobPatches.at(-1)).toMatchObject({ error_code: "internal_error" });
    expect(crash.jobPatches.at(-1)?.error_message).not.toContain("secret");
  });
});
