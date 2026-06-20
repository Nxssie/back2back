// Pure YouTube URL parsing — no I/O, unit-tested in youtube.test.ts.

const ID_RE = /^[a-zA-Z0-9_-]{11}$/;

// Returns a canonical 11-char video id or null. The captured id is validated
// against the strict charset so it can never carry shell/SQL metacharacters
// downstream (defense in depth for the spawn-based yt-dlp calls).
export function extractVideoId(url: string): string | null {
  const match = url.match(
    /(?:(?:music\.)?youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/
  );
  if (match && ID_RE.test(match[1])) return match[1];
  if (ID_RE.test(url)) return url;
  return null;
}

// A URL is a playlist when it has a `list=` param but no `v=` param.
// `watch?v=xxx&list=PLxxx` is treated as a single video (user intent).
export function isPlaylistUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (!["youtube.com", "music.youtube.com"].includes(host)) return false;
    return !!u.searchParams.get("list") && !u.searchParams.get("v");
  } catch {
    return false;
  }
}
