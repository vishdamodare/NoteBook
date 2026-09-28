import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAiProvider } from "@/lib/ai/provider";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchVideoMetadata } from "@/lib/youtube/metadata";
import { getTranscriptProvider, parseTranscriptText, transcriptLength } from "@/lib/youtube/transcript";
import { parseYouTubeUrl } from "@/lib/youtube/url";
import { runProcessingJob, type JobRepo, type PipelineVideo } from "./pipeline";

// A job that hasn't progressed for this long is treated as dead (e.g. the
// serverless function was killed) and may be retried.
const STALE_JOB_MS = 10 * 60 * 1000;

export type StartResult =
  | { ok: true; jobId: string; deduplicated: boolean; run?: () => Promise<unknown> }
  | { ok: false; status: number; code: string; message: string };

const fail = (status: number, code: string, message: string): StartResult => ({ ok: false, status, code, message });

function createRepo(admin: SupabaseClient): JobRepo {
  return {
    async updateJob(jobId, patch) {
      const { error } = await admin.from("processing_jobs").update(patch).eq("id", jobId);
      if (error) throw error;
    },
    async updateVideo(videoRowId, patch) {
      const { error } = await admin.from("videos").update(patch).eq("id", videoRowId);
      if (error) throw error;
    },
    async insertSummary(row) {
      const { data, error } = await admin.from("summaries").insert(row).select("id").single();
      if (error) throw error;
      return data;
    },
  };
}

/**
 * Validates the request, records the video/transcript and creates (or reuses)
 * a processing job. Ownership is checked with the *user's* client (RLS) before
 * the service-role client is used for anything.
 */
export async function startVideoJob(
  userClient: SupabaseClient,
  userId: string,
  input: { pageId: string; url?: string; transcript?: string },
): Promise<StartResult> {
  const { data: page, error: pageError } = await userClient
    .from("pages")
    .select("id,page_type")
    .eq("id", input.pageId)
    .maybeSingle();
  if (pageError) return fail(500, "database_error", "Couldn't load the page.");
  if (!page) return fail(404, "not_found", "Page not found.");
  if (page.page_type !== "youtube") return fail(400, "wrong_page_type", "This page isn't a YouTube notes page.");

  const admin = createAdminClient();
  if (!admin) {
    return fail(503, "not_configured", "Video processing isn't configured on this server (SUPABASE_SERVICE_ROLE_KEY).");
  }

  let parsedUrl: { videoId: string; url: string } | null = null;
  if (input.url !== undefined) {
    const parsed = parseYouTubeUrl(input.url);
    if (!parsed.ok) return fail(400, "invalid_url", parsed.error);
    parsedUrl = parsed;
  }

  let segments = null;
  if (input.transcript !== undefined) {
    if (input.transcript.length > serverEnv.aiMaxTranscriptChars) {
      return fail(413, "transcript_too_long", "That transcript is too long.");
    }
    segments = parseTranscriptText(input.transcript);
    if (!segments.length) return fail(400, "transcript_empty", "The transcript is empty.");
    if (transcriptLength(segments) > serverEnv.aiMaxTranscriptChars) {
      return fail(413, "transcript_too_long", "That transcript is too long.");
    }
  }

  // Upsert the page's video row.
  const { data: existing } = await admin.from("videos").select("id,video_id").eq("page_id", page.id).maybeSingle();
  let videoRowId = existing?.id as string | undefined;
  if (parsedUrl && existing && existing.video_id !== parsedUrl.videoId) {
    // A different video on the same page: reset everything derived from the old one.
    const { error } = await admin
      .from("videos")
      .update({
        video_id: parsedUrl.videoId,
        video_url: parsedUrl.url,
        video_title: null,
        channel_name: null,
        thumbnail_url: null,
        duration_seconds: null,
        description: null,
        metadata_status: "pending",
        transcript_status: "pending",
        transcript_source: null,
        transcript_segments: null,
      })
      .eq("id", existing.id);
    if (error) return fail(500, "database_error", "Couldn't save the video.");
  } else if (parsedUrl && !existing) {
    const { data, error } = await admin
      .from("videos")
      .insert({ page_id: page.id, video_id: parsedUrl.videoId, video_url: parsedUrl.url })
      .select("id")
      .single();
    if (error) return fail(500, "database_error", "Couldn't save the video.");
    videoRowId = data.id;
  }
  if (!videoRowId) return fail(400, "missing_url", "Paste a YouTube link first.");

  if (segments) {
    const { error } = await admin
      .from("videos")
      .update({ transcript_segments: segments, transcript_status: "available", transcript_source: "manual" })
      .eq("id", videoRowId);
    if (error) return fail(500, "database_error", "Couldn't save the transcript.");
  }

  // Idempotency: reuse an active job rather than starting a duplicate.
  const { data: active } = await admin
    .from("processing_jobs")
    .select("id,updated_at")
    .eq("video_id", videoRowId)
    .not("status", "in", "(completed,failed)")
    .maybeSingle();
  if (active) {
    if (Date.now() - new Date(active.updated_at).getTime() < STALE_JOB_MS) {
      return { ok: true, jobId: active.id, deduplicated: true };
    }
    await admin
      .from("processing_jobs")
      .update({ status: "failed", error_code: "timeout", error_message: "Processing timed out." })
      .eq("id", active.id);
  }

  // Rate limit expensive AI work per user. Users can't delete job rows (RLS), so this can't be bypassed.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await admin
    .from("processing_jobs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);
  if ((count ?? 0) >= serverEnv.aiJobsPerHour) {
    return fail(429, "rate_limited", "You've reached the hourly limit for generating notes. Please try again later.");
  }

  const { data: job, error: jobError } = await admin
    .from("processing_jobs")
    .insert({ user_id: userId, video_id: videoRowId })
    .select("id,attempts")
    .single();
  if (jobError) {
    if (jobError.code === "23505") {
      // Lost a race with a concurrent request: return the job it created.
      const { data: raced } = await admin
        .from("processing_jobs")
        .select("id")
        .eq("video_id", videoRowId)
        .not("status", "in", "(completed,failed)")
        .maybeSingle();
      if (raced) return { ok: true, jobId: raced.id, deduplicated: true };
    }
    return fail(500, "database_error", "Couldn't start processing.");
  }

  const run = async () => {
    const { data: video } = await admin
      .from("videos")
      .select("id,video_id,video_title,metadata_status,transcript_segments")
      .eq("id", videoRowId)
      .single();
    return runProcessingJob(job, video as PipelineVideo, {
      repo: createRepo(admin),
      fetchMetadata: (id) => fetchVideoMetadata(id, { apiKey: serverEnv.youtubeApiKey }),
      transcriptProvider: getTranscriptProvider(),
      createAi: createAiProvider,
      limits: { chunkChars: serverEnv.aiChunkChars, maxTranscriptChars: serverEnv.aiMaxTranscriptChars },
    });
  };

  return { ok: true, jobId: job.id, deduplicated: false, run };
}
