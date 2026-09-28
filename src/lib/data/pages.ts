// Page, video and job data access. Works with any Supabase client; RLS enforces ownership.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { StoredSummary } from "@/lib/validation/summary";
import type { Page, PageSummary, PageType, ProcessingJob, RichTextDoc, Video } from "@/types/models";

const SUMMARY_COLUMNS = "id,notebook_id,title,page_type,position,created_at,updated_at";

/** Position for an item placed between two neighbours (fractional ordering). */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1;
  if (before === null) return after! - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}

export async function listPages(sb: SupabaseClient, notebookId: string): Promise<PageSummary[]> {
  const { data, error } = await sb.from("pages").select(SUMMARY_COLUMNS).eq("notebook_id", notebookId).order("position");
  if (error) throw error;
  return data as PageSummary[];
}

export async function getPage(sb: SupabaseClient, id: string): Promise<Page | null> {
  const { data, error } = await sb.from("pages").select(`${SUMMARY_COLUMNS},content_json,revision`).eq("id", id).maybeSingle();
  if (error) throw error;
  return data as Page | null;
}

export async function createPage(
  sb: SupabaseClient,
  notebookId: string,
  pageType: PageType,
  init: { title?: string; content_json?: unknown } = {},
): Promise<PageSummary> {
  const { data, error } = await sb
    .from("pages")
    .insert({ notebook_id: notebookId, page_type: pageType, title: init.title ?? "", ...(init.content_json ? { content_json: init.content_json } : {}) })
    .select(SUMMARY_COLUMNS)
    .single();
  if (error) throw error;
  return data as PageSummary;
}

export type SaveResult = { ok: true; revision: number; updated_at: string } | { ok: false; reason: "conflict" | "not_found" };

/**
 * Saves title/content only if the stored revision still matches, so an older
 * tab or device can never silently overwrite newer content.
 */
export async function savePage(
  sb: SupabaseClient,
  id: string,
  patch: { title?: string; content_json?: RichTextDoc },
  expectedRevision: number,
): Promise<SaveResult> {
  const { data, error } = await sb
    .from("pages")
    .update(patch)
    .eq("id", id)
    .eq("revision", expectedRevision)
    .select("revision,updated_at")
    .maybeSingle();
  if (error) throw error;
  if (data) return { ok: true, revision: data.revision, updated_at: data.updated_at };
  const { data: exists } = await sb.from("pages").select("id").eq("id", id).maybeSingle();
  return { ok: false, reason: exists ? "conflict" : "not_found" };
}

export async function deletePage(sb: SupabaseClient, id: string): Promise<void> {
  const { error } = await sb.from("pages").delete().eq("id", id);
  if (error) throw error;
}

export async function duplicatePage(sb: SupabaseClient, id: string): Promise<PageSummary> {
  const page = await getPage(sb, id);
  if (!page) throw new Error("Page not found");
  // Video data is not copied: the duplicate is a plain snapshot of the notes.
  return createPage(sb, page.notebook_id, "note", {
    title: `${page.title.trim() || "Untitled"} (copy)`.slice(0, 300),
    content_json: page.content_json,
  });
}

export async function setPagePosition(sb: SupabaseClient, id: string, position: number): Promise<void> {
  const { error } = await sb.from("pages").update({ position }).eq("id", id);
  if (error) throw error;
}

export async function movePageToNotebook(sb: SupabaseClient, id: string, notebookId: string): Promise<void> {
  const { data: last } = await sb
    .from("pages")
    .select("position")
    .eq("notebook_id", notebookId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error } = await sb
    .from("pages")
    .update({ notebook_id: notebookId, position: (last?.position ?? 0) + 1 })
    .eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Videos, jobs, summaries (read-only for clients; written by the server)
// ---------------------------------------------------------------------------

const VIDEO_COLUMNS =
  "id,page_id,video_id,video_url,video_title,channel_name,thumbnail_url,duration_seconds,metadata_status,transcript_status,transcript_source,updated_at";
const JOB_COLUMNS = "id,video_id,status,error_code,error_message,attempts,summary_id,created_at,updated_at,completed_at";

export async function getVideoForPage(sb: SupabaseClient, pageId: string): Promise<Video | null> {
  const { data, error } = await sb.from("videos").select(VIDEO_COLUMNS).eq("page_id", pageId).maybeSingle();
  if (error) throw error;
  return data as Video | null;
}

export async function getLatestJob(sb: SupabaseClient, videoRowId: string): Promise<ProcessingJob | null> {
  const { data, error } = await sb
    .from("processing_jobs")
    .select(JOB_COLUMNS)
    .eq("video_id", videoRowId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as ProcessingJob | null;
}

export async function getJob(sb: SupabaseClient, jobId: string): Promise<ProcessingJob | null> {
  const { data, error } = await sb.from("processing_jobs").select(JOB_COLUMNS).eq("id", jobId).maybeSingle();
  if (error) throw error;
  return data as ProcessingJob | null;
}

export async function getLatestSummary(
  sb: SupabaseClient,
  videoRowId: string,
): Promise<{ id: string; summary_json: StoredSummary; created_at: string } | null> {
  const { data, error } = await sb
    .from("summaries")
    .select("id,summary_json,created_at")
    .eq("video_id", videoRowId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; summary_json: StoredSummary; created_at: string } | null;
}
