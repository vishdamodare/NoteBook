// Pure YouTube URL parsing, safe for both client and server.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const PATH_PREFIXES = ["shorts", "embed", "live", "v"];

export type ParsedYouTubeUrl = { ok: true; videoId: string; url: string } | { ok: false; error: string };

export function isValidVideoId(id: unknown): id is string {
  return typeof id === "string" && VIDEO_ID.test(id);
}

export function canonicalVideoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function parseYouTubeUrl(input: string): ParsedYouTubeUrl {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Paste a YouTube link." };
  if (raw.length > 2048) return { ok: false, error: "That link is too long." };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "That doesn't look like a valid link." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "Use an https:// YouTube link." };
  if (url.username || url.password || url.port || !ALLOWED_HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, error: "Only youtube.com and youtu.be links are supported." };
  }

  const segments = url.pathname.split("/").filter(Boolean);
  let id: string | null = null;
  if (url.hostname.toLowerCase() === "youtu.be") {
    id = segments[0] ?? null;
  } else if (segments[0] === "watch") {
    id = url.searchParams.get("v");
  } else if (PATH_PREFIXES.includes(segments[0] ?? "")) {
    id = segments[1] ?? null;
  }

  if (!isValidVideoId(id)) return { ok: false, error: "We couldn't find a video ID in that link." };
  return { ok: true, videoId: id, url: canonicalVideoUrl(id) };
}
