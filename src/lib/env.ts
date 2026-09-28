import "server-only";

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Server-only configuration. Nothing here is ever sent to the browser.
export const serverEnv = {
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || null,
  openaiApiKey: process.env.OPENAI_API_KEY || null,
  openaiModel: process.env.OPENAI_MODEL || null,
  youtubeApiKey: process.env.YOUTUBE_API_KEY || null,
  aiChunkChars: int(process.env.AI_CHUNK_CHARS, 24_000),
  aiMaxTranscriptChars: int(process.env.AI_MAX_TRANSCRIPT_CHARS, 400_000),
  aiJobsPerHour: int(process.env.AI_JOBS_PER_HOUR, 10),
};
