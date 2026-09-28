import { canonicalVideoUrl, isValidVideoId } from "./url";

export interface VideoMetadata {
  title: string | null;
  channelName: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  description: string | null;
}

export type MetadataErrorCode = "not_found" | "private" | "rate_limited" | "provider_error";
export type MetadataResult = { ok: true; metadata: VideoMetadata } | { ok: false; code: MetadataErrorCode; message: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** "PT1H2M3S" -> 3723. Returns null for anything unparseable. */
export function parseIsoDuration(value: string | undefined | null): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value ?? "");
  if (!m || !value || value === "P" || value === "PT") return null;
  const [, d, h, min, s] = m.map((x) => Number(x ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Fetches public video metadata. Only fixed YouTube endpoints are contacted and
 * the video ID is validated first, so user input can't redirect the request.
 * Uses the YouTube Data API when a key is configured, otherwise oEmbed (which
 * has no duration or description).
 */
export async function fetchVideoMetadata(
  videoId: string,
  { apiKey, fetchImpl = fetch }: { apiKey?: string | null; fetchImpl?: FetchLike } = {},
): Promise<MetadataResult> {
  if (!isValidVideoId(videoId)) return { ok: false, code: "not_found", message: "Invalid video ID." };
  const init: RequestInit = { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } };

  try {
    if (apiKey) {
      const url = new URL("https://www.googleapis.com/youtube/v3/videos");
      url.search = new URLSearchParams({ part: "snippet,contentDetails", id: videoId, key: apiKey }).toString();
      const res = await fetchImpl(url.toString(), init);
      if (res.status === 403 || res.status === 429) {
        return { ok: false, code: "rate_limited", message: "YouTube is limiting requests right now." };
      }
      if (!res.ok) return { ok: false, code: "provider_error", message: "YouTube metadata request failed." };
      const body = (await res.json()) as { items?: Array<Record<string, any>> };
      const item = body.items?.[0];
      if (!item) return { ok: false, code: "not_found", message: "This video is private, deleted or unavailable." };
      const thumbs = item.snippet?.thumbnails ?? {};
      return {
        ok: true,
        metadata: {
          title: str(item.snippet?.title),
          channelName: str(item.snippet?.channelTitle),
          thumbnailUrl: str((thumbs.high ?? thumbs.medium ?? thumbs.default)?.url),
          durationSeconds: parseIsoDuration(item.contentDetails?.duration),
          description: str(item.snippet?.description)?.slice(0, 5000) ?? null,
        },
      };
    }

    const url = new URL("https://www.youtube.com/oembed");
    url.search = new URLSearchParams({ format: "json", url: canonicalVideoUrl(videoId) }).toString();
    const res = await fetchImpl(url.toString(), init);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: "private", message: "This video is private or can't be embedded." };
    }
    if (res.status === 404 || res.status === 400) {
      return { ok: false, code: "not_found", message: "This video was not found. It may be deleted or private." };
    }
    if (res.status === 429) return { ok: false, code: "rate_limited", message: "YouTube is limiting requests right now." };
    if (!res.ok) return { ok: false, code: "provider_error", message: "YouTube metadata request failed." };
    const body = (await res.json()) as Record<string, unknown>;
    return {
      ok: true,
      metadata: {
        title: str(body.title),
        channelName: str(body.author_name),
        thumbnailUrl: str(body.thumbnail_url),
        durationSeconds: null,
        description: null,
      },
    };
  } catch {
    return { ok: false, code: "provider_error", message: "Couldn't reach YouTube." };
  }
}
