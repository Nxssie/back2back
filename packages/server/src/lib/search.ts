import { spawn } from "child_process";
import { YTDLP_BASE_ARGS } from "./ytdlp";
import type { Source } from "./sources";

export type SearchableSource = "youtube" | "soundcloud" | "twitch";

export type SearchResult = {
  source: Source;
  videoId: string;
  title: string;
  duration: number | null;
  uploader: string | null;
  url: string;
  thumbnail: string | null;
};

export async function searchTracks(
  query: string,
  source: SearchableSource,
  limit: number,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const searchPrefix = source === "youtube" ? "ytsearch" : source === "twitch" ? "twitchsearch" : "scsearch";

  return new Promise<SearchResult[]>((resolve) => {
    const proc = spawn(
      "yt-dlp",
      [`${searchPrefix}${limit}:${query}`, "--dump-json", "--flat-playlist", "--no-warnings", ...YTDLP_BASE_ARGS],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    let output = "";
    let done = false;
    const finish = (val: SearchResult[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    // Kill a hung yt-dlp instead of leaking the process and never responding.
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      finish([]);
    }, 15_000);

    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      // Cap the buffer so a pathological response can't exhaust memory.
      if (output.length > 1_000_000) {
        try { proc.kill("SIGKILL"); } catch {}
        finish([]);
      }
    });
    proc.on("close", () => {
      const parsed = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const e = JSON.parse(line);
            if (!e.id || !e.title) return [];
            const videoId = String(e.id);
            const url = source === "youtube"
              ? `https://www.youtube.com/watch?v=${videoId}`
              : String(e.webpage_url || e.url || "");
            if (!url) return [];
            const thumbnail = source === "youtube"
              ? `https://i.ytimg.com/vi/${videoId}/default.jpg`
              : (e.thumbnail ?? e.thumbnails?.at(-1)?.url ?? null);
            return [{ source, videoId, title: String(e.title), duration: e.duration ?? null, uploader: e.uploader ?? null, url, thumbnail }];
          } catch {
            return [];
          }
        });
      finish(parsed);
    });
    proc.on("error", () => finish([]));
    // Cancel the spawn if the client disconnects mid-request.
    signal?.addEventListener("abort", () => {
      try { proc.kill("SIGKILL"); } catch {}
      finish([]);
    });
  });
}

export type SelectOption = { label: string; value: string; description: string };

// Discord rejects string-select labels and descriptions longer than 100 chars.
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor((total % 3600) / 60);
  const hours = Math.floor(total / 3600);
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function toSelectOptions(results: SearchResult[], limit = 25): SelectOption[] {
  const options: SelectOption[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.url)) continue;
    seen.add(result.url);
    const duration = result.duration == null ? null : formatDuration(result.duration);
    options.push({
      label: truncate(result.title, 100),
      value: result.url,
      description: truncate([result.uploader, duration].filter(Boolean).join(" · "), 100),
    });
    if (options.length >= limit) break;
  }
  return options;
}
