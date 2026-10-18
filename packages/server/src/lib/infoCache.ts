// A short-lived, bounded cache of yt-dlp info JSON, keyed by the URL that will
// be streamed. Resolving a track (`yt-dlp -J`) already does the expensive part
// of starting playback — the full YouTube extraction — so the stream can reuse
// that result through `--load-info-json -` instead of extracting a second
// time. Measured locally: first audio byte ~2.0 s through a fresh extraction,
// ~0.5 s from a cached one.
//
// Pure (no I/O) and clock-injectable, so expiry is unit-tested without sleeping.

// Ten minutes is far below the lifetime of YouTube's signed media URLs (~6 h),
// so a cached entry can never stream from an expired URL; a song that waits
// longer in the queue simply falls back to a fresh extraction.
export const INFO_CACHE_TTL_MS = 10 * 60 * 1000;

// One entry is 86-660 KB of JSON (measured; videos with many formats, like 4K
// remasters, sit at the top), so 20 entries cap the cache at ~13 MB even when
// busy guilds queue faster than they play. Only the next song of each guild
// really needs its entry; anything evicted just extracts fresh.
export const INFO_CACHE_MAX_ENTRIES = 20;

export interface InfoCache {
  set(url: string, json: string): void;
  // Returns the entry and removes it: the stream consumes it exactly once, so a
  // replay of the same song extracts fresh info instead of reusing old URLs.
  take(url: string): string | null;
  readonly size: number;
}

export function createInfoCache(
  options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}
): InfoCache {
  const ttlMs = options.ttlMs ?? INFO_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? INFO_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  // A Map iterates in insertion order, so its first key is always the oldest
  // entry — set() re-inserts on overwrite to keep that true.
  const entries = new Map<string, { json: string; expiresAt: number }>();

  const evictExpired = () => {
    const t = now();
    for (const [url, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(url);
    }
  };

  return {
    set(url, json) {
      evictExpired();
      entries.delete(url);
      entries.set(url, { json, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value as string;
        entries.delete(oldest);
      }
    },
    take(url) {
      const entry = entries.get(url);
      if (!entry) return null;
      entries.delete(url);
      return entry.expiresAt > now() ? entry.json : null;
    },
    get size() {
      evictExpired();
      return entries.size;
    },
  };
}
