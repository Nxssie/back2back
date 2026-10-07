// Optional yt-dlp hardening for servers whose IP YouTube rate-limits/blocks
// (datacenter IPs frequently hit "Sign in to confirm you're not a bot" / 403,
// which makes tracks fail to extract and end almost instantly). Set these in the
// environment — no code change needed — to recover playback:
//   YTDLP_COOKIES=/app/data/cookies.txt          Netscape cookie jar from a logged-in session
//   YTDLP_EXTRACTOR_ARGS=youtube:player_client=default,mweb
//   YTDLP_DOWNLOADER=ffmpeg                        more robust for fragmented/SABR streams
export const YTDLP_BASE_ARGS: string[] = [
  ...(process.env.YTDLP_COOKIES ? ["--cookies", process.env.YTDLP_COOKIES] : []),
  ...(process.env.YTDLP_EXTRACTOR_ARGS ? ["--extractor-args", process.env.YTDLP_EXTRACTOR_ARGS] : []),
];
export const YTDLP_DOWNLOAD_ARGS: string[] = process.env.YTDLP_DOWNLOADER
  ? ["--downloader", process.env.YTDLP_DOWNLOADER]
  : [];
