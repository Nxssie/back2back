// Source detection — pure URL parsing, no I/O. The host allow-list here is the
// security gate that keeps yt-dlp from being pointed at an arbitrary host (SSRF);
// shell injection is separately closed by spawn() passing argv, never a shell.

export type Source = "youtube" | "soundcloud";

const YOUTUBE_HOSTS = new Set(["youtube.com", "music.youtube.com", "youtu.be"]);
const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function detectSource(url: string): Source | null {
  const host = hostOf(url);
  if (!host) return null;
  if (YOUTUBE_HOSTS.has(host)) return "youtube";
  if (SOUNDCLOUD_HOSTS.has(host)) return "soundcloud";
  return null;
}

// A SoundCloud "set" (playlist/album) URL has /sets/ in its path, e.g.
// soundcloud.com/<user>/sets/<slug>.
export function isSoundcloudSetUrl(url: string): boolean {
  const host = hostOf(url);
  if (!host || !SOUNDCLOUD_HOSTS.has(host)) return false;
  try {
    return /\/sets\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
