// Source detection — pure URL parsing, no I/O. The host allow-list here is the
// security gate that keeps yt-dlp from being pointed at an arbitrary host (SSRF);
// shell injection is separately closed by spawn() passing argv, never a shell.

export type Source = "youtube" | "soundcloud" | "twitch" | "generic";

const YOUTUBE_HOSTS = new Set(["youtube.com", "music.youtube.com", "youtu.be"]);
const SOUNDCLOUD_HOSTS = new Set(["soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"]);
const TWITCH_HOSTS = new Set(["twitch.tv", "clips.twitch.tv"]);

// Streaming manifest patterns — file extension in the path or query string.
// Keeps the SSRF gate tight: only direct .m3u8 (HLS) and .mpd (DASH) URLs
// are accepted as generic sources, not arbitrary hostnames.
const MANIFEST_RE = /\.(m3u8|mpd)(?:[?#]|$)/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isManifestUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return MANIFEST_RE.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

export function detectSource(url: string): Source | null {
  const host = hostOf(url);
  if (!host) return null;
  if (YOUTUBE_HOSTS.has(host)) return "youtube";
  if (SOUNDCLOUD_HOSTS.has(host)) return "soundcloud";
  if (TWITCH_HOSTS.has(host)) return "twitch";
  if (isManifestUrl(url)) return "generic";
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
