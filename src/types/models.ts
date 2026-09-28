// Shared data shapes. Mirrors supabase/migrations; free of web/Node APIs so a
// future Expo client can import it unchanged.

export interface RichTextMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface RichTextNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichTextNode[];
  marks?: RichTextMark[];
  text?: string;
}

export interface RichTextDoc {
  type: "doc";
  content?: RichTextNode[];
}

export type PageType = "note" | "youtube";

export interface Profile {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  preferences: Record<string, unknown>;
}

export interface Notebook {
  id: string;
  user_id: string;
  title: string;
  description: string;
  cover_color: string;
  is_favorite: boolean;
  last_opened_at: string | null;
  created_at: string;
  updated_at: string;
  page_count: number;
}

export interface PageSummary {
  id: string;
  notebook_id: string;
  title: string;
  page_type: PageType;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Page extends PageSummary {
  content_json: unknown;
  revision: number;
}

export type AvailabilityStatus = "pending" | "available" | "unavailable";

export interface TranscriptSegment {
  text: string;
  start: number | null;
  duration: number | null;
}

export interface Video {
  id: string;
  page_id: string;
  video_id: string;
  video_url: string;
  video_title: string | null;
  channel_name: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  metadata_status: AvailabilityStatus;
  transcript_status: AvailabilityStatus;
  transcript_source: "provider" | "manual" | null;
  updated_at: string;
}

export const JOB_STATUSES = [
  "pending",
  "fetching_metadata",
  "fetching_transcript",
  "processing",
  "completed",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface ProcessingJob {
  id: string;
  video_id: string;
  status: JobStatus;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  summary_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface SearchResult {
  kind: "notebook" | "page";
  notebook_id: string;
  page_id: string | null;
  title: string;
  notebook_title: string;
  excerpt: string | null;
  updated_at: string;
}
