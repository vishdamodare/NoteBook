export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function displayTitle(title: string | null | undefined, fallback = "Untitled"): string {
  return title?.trim() || fallback;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  if (Number.isNaN(seconds)) return "";
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** 75 -> "1:15", 3725 -> "1:02:05" */
export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Only allow same-origin relative paths as post-login redirects. */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

/** Maps Supabase/PostgREST/network errors to a message that is safe to show users. */
export function userMessage(error: unknown, fallback = "Something went wrong. Please try again."): string {
  const e = error as { code?: string; message?: string; status?: number } | null;
  if (!e) return fallback;
  if (e instanceof TypeError || /fetch failed|network/i.test(e.message ?? "")) {
    return "Can't reach the server. Check your connection and try again.";
  }
  if (e.code === "42501" || e.status === 403) return "You don't have permission to do that.";
  if (e.code === "PGRST301" || e.status === 401) return "Your session has expired. Please sign in again.";
  if (e.code === "23514") return "That value isn't allowed.";
  return fallback;
}
