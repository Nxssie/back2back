// Lyrics lookup via lrclib.net, moved here from the web package so the bot can
// serve /lyrics. The web copy still exists and disappears with packages/web in
// the deletion slice — there is no second runtime consumer to keep in sync.

export const DISCORD_MESSAGE_LIMIT = 2000;

export interface LrcLine {
  timeMs: number;
  text: string;
}

interface LrclibResult {
  id: number;
  trackName: string;
  artistName: string;
  syncedLyrics: string | null;
  plainLyrics: string | null;
}

// Strip common YouTube title noise before searching
export function cleanTitle(title: string): string {
  return title
    .replace(/\(?(official|lyric|music|audio|video|visualizer|4k|hd|hq|explicit|clean|remastered|extended|live|acoustic|instrumental|slowed|reverb|nightcore|sped up)\s*(music video|video|audio|version|mv)?\)?/gi, '')
    .replace(/\[?(official|lyric|music|audio|video|visualizer|4k|hd|hq|explicit|clean|remastered|extended|live|acoustic|instrumental)\s*(music video|video|audio|version|mv)?\]?/gi, '')
    .replace(/\bfeat\.?\s+[^,\[\]()]+/gi, '')
    .replace(/\bft\.?\s+[^,\[\]()]+/gi, '')
    .replace(/\bprod\.?\s+by\s+[^,\[\]()]+/gi, '')
    .replace(/\s*[-–|]\s*[^-–|]*$/, '') // remove " - Topic" or " | Channel" suffix
    .replace(/\s+/g, ' ')
    .trim();
}

// Strip YouTube channel noise from uploader names ("Drake - Topic" → "Drake", "QueenVEVO" → "Queen")
function cleanArtist(artist: string): string {
  return artist
    .replace(/\s*-\s*Topic$/i, '')
    .replace(/VEVO$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse LRC timestamp format [mm:ss.xx] or [mm:ss.xxx]
function parseTimestamp(ts: string): number {
  const match = ts.match(/^(\d+):(\d+)\.(\d+)$/);
  if (!match) return 0;
  const [, mm, ss, frac] = match;
  const ms = frac.length === 2 ? Number(frac) * 10 : Number(frac);
  return Number(mm) * 60_000 + Number(ss) * 1_000 + ms;
}

export function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const raw of lrc.split('\n')) {
    const match = raw.match(/^\[(\d+:\d+\.\d+)\](.*)$/);
    if (!match) continue;
    const text = match[2].trim();
    if (!text) continue; // skip empty lines (instrumental markers)
    lines.push({ timeMs: parseTimestamp(match[1]), text });
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

export async function fetchLyrics(
  title: string,
  artist?: string | null
): Promise<{ lines: LrcLine[]; plain: string | null } | null> {
  const query = cleanTitle(title);
  if (!query) return null;

  try {
    const artistClean = artist ? cleanArtist(artist) : null;
    const q = artistClean ? `${artistClean} ${query}` : query;
    const params = new URLSearchParams({ q });

    const res = await fetch(
      `https://lrclib.net/api/search?${params}`,
      { signal: AbortSignal.timeout(6_000) }
    );
    if (!res.ok) return null;

    const results: LrclibResult[] = await res.json();
    if (!results.length) return null;

    // When we know the artist, prefer results that actually match it
    const artistNorm = artistClean?.toLowerCase();
    const matchesArtist = (r: LrclibResult) =>
      !artistNorm || r.artistName.toLowerCase().includes(artistNorm) || artistNorm.includes(r.artistName.toLowerCase());

    const withSync = results.find((r) => r.syncedLyrics && matchesArtist(r))
      ?? results.find((r) => r.syncedLyrics);
    const best = withSync ?? results.find(matchesArtist) ?? results[0];

    return {
      lines: best.syncedLyrics ? parseLrc(best.syncedLyrics) : [],
      plain: best.plainLyrics ?? null,
    };
  } catch {
    return null;
  }
}

// No karaoke sync over Discord: the panel's timing is not reproducible in a
// message, so the bot posts the text once and Discord rejects anything past
// 2000 characters.
export function formatLyrics(
  lyrics: { lines: LrcLine[]; plain: string | null },
  maxLength = DISCORD_MESSAGE_LIMIT
): string | null {
  const plain = lyrics.plain?.trim();
  const text = plain || lyrics.lines.map((line) => line.text).join("\n").trim();
  if (!text) return null;
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
