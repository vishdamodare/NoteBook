// The YouTube -> notes pipeline, independent of Supabase/Next so it can be
// tested with fakes and moved to a queue worker later without changes.
import { PROMPT_VERSION } from "@/lib/ai/prompts";
import { AiError, type AiProvider } from "@/lib/ai/provider";
import { SummarizeError, summarizeTranscript, type SummarizeLimits } from "@/lib/ai/summarize";
import type { StoredSummary } from "@/lib/validation/summary";
import type { MetadataResult } from "@/lib/youtube/metadata";
import { normalizeSegments, type TranscriptProvider } from "@/lib/youtube/transcript";
import type { AvailabilityStatus, JobStatus, TranscriptSegment } from "@/types/models";

export interface JobPatch {
  status?: JobStatus;
  attempts?: number;
  error_code?: string | null;
  error_message?: string | null;
  summary_id?: string | null;
  completed_at?: string | null;
}

export interface VideoPatch {
  video_title?: string | null;
  channel_name?: string | null;
  thumbnail_url?: string | null;
  duration_seconds?: number | null;
  description?: string | null;
  metadata_status?: AvailabilityStatus;
  transcript_status?: AvailabilityStatus;
  transcript_source?: "provider" | "manual" | null;
  transcript_segments?: TranscriptSegment[] | null;
}

export interface JobRepo {
  updateJob(jobId: string, patch: JobPatch): Promise<void>;
  updateVideo(videoRowId: string, patch: VideoPatch): Promise<void>;
  insertSummary(row: { video_id: string; summary_json: StoredSummary; model: string; prompt_version: string }): Promise<{ id: string }>;
}

export interface PipelineVideo {
  id: string;
  video_id: string;
  video_title: string | null;
  metadata_status: AvailabilityStatus;
  transcript_segments: TranscriptSegment[] | null;
}

export interface PipelineDeps {
  repo: JobRepo;
  fetchMetadata(videoId: string): Promise<MetadataResult>;
  transcriptProvider: TranscriptProvider | null;
  createAi(): AiProvider;
  limits: SummarizeLimits;
}

class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function runProcessingJob(
  job: { id: string; attempts: number },
  video: PipelineVideo,
  deps: PipelineDeps,
): Promise<JobStatus> {
  const { repo } = deps;
  try {
    await repo.updateJob(job.id, { status: "fetching_metadata", attempts: job.attempts + 1, error_code: null, error_message: null });

    let title = video.video_title;
    if (video.metadata_status !== "available") {
      // Metadata is helpful but not required: a pasted transcript can still be summarised.
      const meta = await deps.fetchMetadata(video.video_id);
      if (meta.ok) {
        title = meta.metadata.title;
        await repo.updateVideo(video.id, {
          video_title: meta.metadata.title,
          channel_name: meta.metadata.channelName,
          thumbnail_url: meta.metadata.thumbnailUrl,
          duration_seconds: meta.metadata.durationSeconds,
          description: meta.metadata.description,
          metadata_status: "available",
        });
      } else {
        await repo.updateVideo(video.id, { metadata_status: "unavailable" });
      }
    }

    await repo.updateJob(job.id, { status: "fetching_transcript" });
    let segments = video.transcript_segments;
    if (!segments?.length) {
      const result = deps.transcriptProvider
        ? await deps.transcriptProvider.fetchTranscript(video.video_id)
        : { ok: false as const, code: "unavailable" as const, message: "" };
      if (!result.ok) {
        await repo.updateVideo(video.id, { transcript_status: "unavailable" });
        throw new JobFailure(
          result.code === "rate_limited" ? "transcript_rate_limited" : "transcript_unavailable",
          result.code === "rate_limited"
            ? "The transcript service is busy. Try again in a few minutes, or paste the transcript."
            : "We couldn't get a transcript for this video automatically. Paste or upload the transcript to continue.",
        );
      }
      segments = normalizeSegments(result.segments);
      await repo.updateVideo(video.id, {
        transcript_segments: segments,
        transcript_status: segments.length ? "available" : "unavailable",
        transcript_source: "provider",
      });
    }
    if (!segments.length) {
      throw new JobFailure("transcript_empty", "The transcript is empty. Paste the transcript text to continue.");
    }

    await repo.updateJob(job.id, { status: "processing" });
    const ai = deps.createAi();
    const summary = await summarizeTranscript(ai, segments, title, deps.limits);
    const saved = await repo.insertSummary({
      video_id: video.id,
      summary_json: summary,
      model: ai.model,
      prompt_version: PROMPT_VERSION,
    });

    await repo.updateJob(job.id, { status: "completed", summary_id: saved.id, completed_at: new Date().toISOString() });
    return "completed";
  } catch (error) {
    const known = error instanceof JobFailure || error instanceof SummarizeError || error instanceof AiError;
    const code = known ? error.code : "internal_error";
    const message = known ? error.message : "Something went wrong while generating notes. Please try again.";
    if (!known) console.error("[jobs] unexpected failure", { jobId: job.id, error: error instanceof Error ? error.message : String(error) });
    else console.warn("[jobs] job failed", { jobId: job.id, code });
    await repo.updateJob(job.id, { status: "failed", error_code: code, error_message: message }).catch(() => {});
    return "failed";
  }
}
