import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getCookie, setCookie } from "hono/cookie";
import { serve } from "bun";
import { spawn } from "child_process";
import ffmpegStatic from "ffmpeg-static";
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  PermissionsBitField,
  type VoiceBasedChannel,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  type AudioPlayer,
  type AudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import { db } from "./db";
import { users, rooms, songs, votes, guilds, type User } from "./db/schema";
import { eq, desc, and, inArray, lt, sql } from "drizzle-orm";
import { commands } from "./commands";
import { extractVideoId, isPlaylistUrl } from "./lib/youtube";
import { detectSource, isSoundcloudSetUrl, type Source } from "./lib/sources";
import { encodeJwt, decodeJwt } from "./lib/jwt";
import { skipThreshold } from "./lib/voting";
import path from "node:path";

// --- Config ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI || "http://localhost:3001/auth/discord/callback";
// Where to send the browser after the OAuth flow. Defaults to the Vite dev
// server; in prod set FRONTEND_URL to the public origin (no trailing slash).
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const IS_PROD = process.env.NODE_ENV === "production";
const IS_DEV = process.env.NODE_ENV === "development";
const WEB_DIST_DIR = path.join(import.meta.dirname, "../../web/dist");
const INDEX_HTML = path.join(WEB_DIST_DIR, "index.html");
const PORT = Number(process.env.PORT) || 3001;
const DEFAULT_JWT_SECRET = "back2back-secret-change-in-production";
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Fail fast anywhere but explicit development rather than signing tokens with
// the known default secret — anyone aware of it could forge a token for any
// user id (including an admin) and delete every room.
if (!IS_DEV && (JWT_SECRET === DEFAULT_JWT_SECRET || JWT_SECRET.length < 32)) {
  throw new Error(
    "JWT_SECRET must be set to a strong (>= 32 char) secret outside development"
  );
}

// Allowed browser origins for cross-origin requests (defense in depth; in prod
// everything is same-origin behind nginx). Same-origin requests (no Origin
// header) always pass; localhost/LAN is only allowed outside production.
const CORS_ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || FRONTEND_URL)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// Global moderators — comma-separated Discord user IDs in the env. These users
// can delete any room. Kept as config (not a DB role) so granting admin is a
// deploy concern, no UI required.
const ADMIN_DISCORD_IDS = new Set(
  (process.env.ADMIN_DISCORD_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

// Empty, idle rooms are garbage-collected after this many hours.
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_HOURS || 24) * 60 * 60 * 1000;
// Played songs (and their votes) are purged once older than this, so songs and
// votes don't grow without bound in long-lived rooms.
const PLAYED_SONG_TTL_MS =
  Number(process.env.PLAYED_SONG_TTL_HOURS || 24) * 60 * 60 * 1000;
// Leave a voice channel once the queue has been empty (and nothing playing) for
// this long, so the bot isn't parked in a channel holding a voice slot for no
// reason. Override with EMPTY_QUEUE_LEAVE_MINUTES.
const EMPTY_QUEUE_LEAVE_MS =
  Number(process.env.EMPTY_QUEUE_LEAVE_MINUTES || 5) * 60 * 1000;
// Leave a voice channel once the bot has been the only one in it for this long.
const ALONE_LEAVE_MS = 60 * 1000;

function isAdmin(user: User | null): boolean {
  return !!user && ADMIN_DISCORD_IDS.has(user.id);
}

// Optional yt-dlp hardening for servers whose IP YouTube rate-limits/blocks
// (datacenter IPs frequently hit "Sign in to confirm you're not a bot" / 403,
// which makes tracks fail to extract and end almost instantly). Set these in the
// environment — no code change needed — to recover playback:
//   YTDLP_COOKIES=/app/data/cookies.txt          Netscape cookie jar from a logged-in session
//   YTDLP_EXTRACTOR_ARGS=youtube:player_client=default,mweb
//   YTDLP_DOWNLOADER=ffmpeg                        more robust for fragmented/SABR streams
const YTDLP_BASE_ARGS: string[] = [
  ...(process.env.YTDLP_COOKIES ? ["--cookies", process.env.YTDLP_COOKIES] : []),
  ...(process.env.YTDLP_EXTRACTOR_ARGS ? ["--extractor-args", process.env.YTDLP_EXTRACTOR_ARGS] : []),
];
const YTDLP_DOWNLOAD_ARGS: string[] = process.env.YTDLP_DOWNLOADER
  ? ["--downloader", process.env.YTDLP_DOWNLOADER]
  : [];

// --- State (in-memory; this is a deliberately single-instance service) ---
const players = new Map<string, AudioPlayer>();
const connections = new Map<string, VoiceConnection>();
const guildRoomMap = new Map<string, string>();
const currentTracks = new Map<
  string,
  { songId: number; videoId: string; startedAt: number; cleanup: () => void }
>();

// Auto-advance failure control. A track that goes Idle far sooner than it could
// have played almost certainly never produced audio (yt-dlp/ffmpeg failed). With
// a failing queue (e.g. a 54-song playlist on a blocked IP) the Idle handler
// would otherwise advance instantly through every entry, spawning a yt-dlp +
// ffmpeg storm that pins the CPU. So we count consecutive fast failures per
// guild, back off before retrying, and stop after a cap.
const consecutiveFailures = new Map<string, number>();
const pendingAdvance = new Map<string, ReturnType<typeof setTimeout>>();
// guildIds whose upcoming Idle was caused by an intentional user skip, so it is
// not mis-counted as a playback failure.
const recentSkip = new Set<string>();
// Per-guild lock so two advances can't overlap (the POST handlers fire
// playNextFromRoom without awaiting, and currentTracks isn't set until after an
// up-to-15s getVideoInfo await — without this, two concurrent advances each
// spawn yt-dlp+ffmpeg and the first pair is orphaned/leaked).
const advancing = new Set<string>();
// Timestamps tracking when each guild's voice connection first became idle by
// each metric, so we can leave after a grace period instead of immediately.
const emptySince = new Map<string, number>();
const aloneSince = new Map<string, number>();
const FAST_FAIL_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const failureBackoffMs = (n: number) => [3_000, 8_000, 15_000, 30_000][n - 1] ?? 30_000;

// --- Discord Bot ---
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const nowSeconds = () => Math.floor(Date.now() / 1000);

// --- Auth ---
async function getUser(c: any): Promise<User | null> {
  const token = getCookie(c, "b2b_token");
  if (!token) return null;
  const payload = await decodeJwt(token, JWT_SECRET);
  if (!payload?.sub) return null;
  const user = await db
    .select()
    .from(users)
    .where(eq(users.id, payload.sub as string))
    .get();
  if (!user) return null;
  // Reject tokens whose version is behind the user's current one (revoked on
  // logout).
  if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) return null;
  return user;
}

// Ensure a room row exists. Ownership (createdBy) is set exactly once — at
// creation, to the user performing the creating write — and is NEVER claimed
// later. The atomic upsert only bumps the activity timestamp on an existing
// row, so a read can't silently acquire ownership (which would grant delete
// rights). Only call this from write paths, never from a GET.
async function ensureRoom(id: string, userId?: string | null) {
  await db
    .insert(rooms)
    .values({ id, createdBy: userId ?? null, lastActivityAt: nowSeconds() })
    .onConflictDoUpdate({
      target: rooms.id,
      set: { lastActivityAt: nowSeconds() },
    });
  return db.select().from(rooms).where(eq(rooms.id, id)).get();
}

// --- Simple in-memory rate limiter (fixed window per ip+key) ---
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}
function clientKey(c: any): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "local"
  );
}

// --- yt-dlp + ffmpeg audio stream ---
// Returns the audio resource plus a cleanup() that kills both child processes,
// so a finished/skipped/stopped track never leaves yt-dlp or ffmpeg lingering.
function createAudioStream(url: string): {
  resource: AudioResource;
  cleanup: () => void;
} {
  const ytdlp = spawn(
    "yt-dlp",
    ["-f", "bestaudio", "--no-playlist", ...YTDLP_BASE_ARGS, ...YTDLP_DOWNLOAD_ARGS, "-o", "-", url],
    // stderr is piped (not ignored) so an extraction failure — 403, "Sign in to
    // confirm you're not a bot", "forcing SABR" — is logged instead of silently
    // producing an empty stream that ends the track after ~2s.
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let ytdlpErr = "";
  ytdlp.stderr.on("data", (chunk) => {
    if (ytdlpErr.length < 4000) ytdlpErr += chunk.toString();
  });

  const ffmpeg = spawn(
    ffmpegStatic!,
    [
      "-i", "pipe:0",
      "-c:a", "libopus",
      "-ar", "48000",
      "-ac", "2",
      "-b:a", "128k",
      "-f", "ogg",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "ignore"] }
  );

  ytdlp.stdout.pipe(ffmpeg.stdin);

  ytdlp.on("error", (e) => console.error(`❌ yt-dlp error for ${url}:`, e));
  ffmpeg.on("error", (e) => console.error(`❌ ffmpeg error for ${url}:`, e));

  // If ffmpeg exits (for any reason), yt-dlp is no longer useful.
  ffmpeg.on("close", () => {
    if (!ytdlp.killed) {
      try { ytdlp.kill("SIGKILL"); } catch {}
    }
  });
  // When yt-dlp finishes downloading (exit 0), let ffmpeg drain its buffer
  // and close naturally — killing it here would cut the end of the track.
  // Only kill ffmpeg if yt-dlp crashed (non-zero exit).
  ytdlp.on("close", (code) => {
    if (code !== 0) {
      const tail = ytdlpErr.trim().split("\n").slice(-3).join(" | ");
      console.error(`❌ yt-dlp exited ${code} for ${url}: ${tail || "(no stderr)"}`);
      if (!ffmpeg.killed) {
        try { ffmpeg.kill("SIGKILL"); } catch {}
      }
    }
  });

  const cleanup = () => {
    try { if (!ytdlp.killed) ytdlp.kill("SIGKILL"); } catch {}
    try { if (!ffmpeg.killed) ffmpeg.kill("SIGKILL"); } catch {}
  };

  return {
    resource: createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus }),
    cleanup,
  };
}

// spawn (not exec) passes the URL as a literal argv entry, never through a
// shell — this closes the command-injection sink that string interpolation
// into `yt-dlp --get-title "..."` opened.
function getVideoInfo(url: string): Promise<{ title: string; uploader: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn("yt-dlp", ["--get-title", "--no-warnings", ...YTDLP_BASE_ARGS, url], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    let out = "";
    proc.stdout.on("data", (chunk) => (out += chunk));
    proc.on("close", () => resolve({ title: out.trim() || url, uploader: null }));
    proc.on("error", () => resolve({ title: url, uploader: null }));
  });
}

// Single yt-dlp round trip for a SoundCloud track: id, title, uploader,
// canonical webpage url, and the highest-res artwork available (SoundCloud has
// no predictable CDN pattern like YouTube's i.ytimg.com, so the URL must be
// captured here). Returns null on timeout/failure so callers can 400 instead of
// inserting a song with no usable metadata.
function resolveSoundcloudTrack(url: string): Promise<{
  videoId: string;
  url: string;
  title: string;
  uploader: string | null;
  thumbnail: string | null;
} | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "yt-dlp",
      ["--dump-json", "--no-playlist", "--no-warnings", ...YTDLP_BASE_ARGS, url],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }
    );
    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", () => {
      try {
        const d = JSON.parse(output.trim());
        if (!d.id || !d.title) return resolve(null);
        const thumbnail = d.thumbnail ?? d.thumbnails?.at(-1)?.url ?? null;
        resolve({
          videoId: String(d.id),
          url: d.webpage_url || url,
          title: String(d.title),
          uploader: d.uploader ?? null,
          thumbnail,
        });
      } catch {
        resolve(null);
      }
    });
    proc.on("error", () => resolve(null));
  });
}

// Shared by the HTTP add-song endpoint and the Discord /play command so the
// two surfaces can't drift on how a single track is resolved.
async function resolveSingleTrack(
  url: string,
  source: Source
): Promise<{
  videoId: string;
  url: string;
  title: string | null;
  uploader: string | null;
  thumbnail: string | null;
} | null> {
  if (source === "youtube") {
    const videoId = extractVideoId(url);
    if (!videoId) return null;
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const { title, uploader } = await getVideoInfo(canonicalUrl);
    return { videoId, url: canonicalUrl, title, uploader, thumbnail: null };
  }
  return resolveSoundcloudTrack(url);
}

// Fully release a guild's playback: kill child processes, stop the player,
// destroy the voice connection, and drop all per-guild state. Idempotent.
function teardownGuild(guildId: string) {
  // Cancel any scheduled backoff advance and drop per-guild failure/skip state.
  const pending = pendingAdvance.get(guildId);
  if (pending) { clearTimeout(pending); pendingAdvance.delete(guildId); }
  consecutiveFailures.delete(guildId);
  recentSkip.delete(guildId);
  emptySince.delete(guildId);
  aloneSince.delete(guildId);
  // Drop the room mapping BEFORE stopping the player: stop() fires Idle, and the
  // Idle handler must not find a room to advance into while we're tearing down.
  guildRoomMap.delete(guildId);
  const track = currentTracks.get(guildId);
  track?.cleanup();
  currentTracks.delete(guildId);
  players.get(guildId)?.stop();
  players.delete(guildId);
  const conn = connections.get(guildId);
  if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) {
    try { conn.destroy(); } catch {}
  }
  connections.delete(guildId);
}

// --- Voice helpers ---
function setupPlayer(guildId: string): AudioPlayer {
  let player = players.get(guildId);
  if (player) return player;

  player = createAudioPlayer();

  player.on(AudioPlayerStatus.Idle, async () => {
    const track = currentTracks.get(guildId);
    const playedMs = track ? Date.now() - track.startedAt : 0;
    const wasSkip = recentSkip.delete(guildId); // consume the skip marker, if any
    if (track) {
      track.cleanup();
      await db.update(songs).set({ played: true }).where(eq(songs.id, track.songId)).run();
      currentTracks.delete(guildId);
    }

    const roomId = guildRoomMap.get(guildId);
    if (!roomId) return;

    // Healthy advance: an intentional user skip, or a track that actually played
    // for a while. Reset the failure streak and move on immediately.
    if (wasSkip || !track || playedMs >= FAST_FAIL_MS) {
      consecutiveFailures.set(guildId, 0);
      console.log(`⏹️ Track finished in guild ${guildId} (${(playedMs / 1000).toFixed(0)}s)`);
      await playNextFromRoom(roomId, guildId);
      return;
    }

    // Ended far too soon to have produced audio — almost certainly an extraction
    // failure (yt-dlp blocked/outdated). Back off so a queue of unplayable tracks
    // can't spawn a yt-dlp/ffmpeg storm by advancing instantly through every one.
    const fails = (consecutiveFailures.get(guildId) ?? 0) + 1;
    consecutiveFailures.set(guildId, fails);
    console.warn(
      `⚠️ Track in guild ${guildId} ended after ${playedMs}ms — likely extraction failure (${fails}/${MAX_CONSECUTIVE_FAILURES})`
    );

    if (fails >= MAX_CONSECUTIVE_FAILURES) {
      console.error(
        `⛔ ${MAX_CONSECUTIVE_FAILURES} consecutive playback failures in guild ${guildId}; stopping auto-advance. Check yt-dlp (IP blocked / outdated?).`
      );
      consecutiveFailures.set(guildId, 0);
      return;
    }

    const delay = failureBackoffMs(fails);
    const timer = setTimeout(() => {
      pendingAdvance.delete(guildId);
      void playNextFromRoom(roomId, guildId);
    }, delay);
    pendingAdvance.set(guildId, timer);
  });

  player.on("error", (error) => {
    console.error(`❌ Audio player error in guild ${guildId}:`, error);
  });

  players.set(guildId, player);
  return player;
}

async function connectToVoiceChannel(
  guildId: string,
  channelId: string
): Promise<VoiceConnection> {
  let connection = connections.get(guildId);
  if (connection) return connection;

  const guild = discord.guilds.cache.get(guildId);
  if (!guild) throw new Error("Guild not found");

  connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator: guild.voiceAdapterCreator,
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection!, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection!, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      // Reconnect failed — fully tear down so we don't leak the UDP socket and
      // voice websocket, then drop the per-guild state.
      teardownGuild(guildId);
    }
  });

  connections.set(guildId, connection);
  console.log(`🔊 Joined voice channel: ${channelId} in guild ${guildId}`);
  return connection;
}

// --- Play next song ---
async function playNextFromRoom(roomId: string, guildId: string) {
  // Serialize advances per guild: the POST handlers fire this without awaiting,
  // and currentTracks isn't set until after the getVideoInfo await, so two
  // callers could otherwise both spawn yt-dlp+ffmpeg and orphan the first pair.
  if (advancing.has(guildId)) return;
  advancing.add(guildId);
  try {
    await playNextFromRoomInner(roomId, guildId);
  } finally {
    advancing.delete(guildId);
  }
}

async function playNextFromRoomInner(roomId: string, guildId: string) {
  const allSongs = await db
    .select()
    .from(songs)
    .where(eq(songs.roomId, roomId))
    .orderBy(desc(songs.votes), songs.createdAt)
    .all();

  const nextSong = allSongs.find((s) => !s.played);

  if (!nextSong) {
    console.log(`📭 No more songs in room ${roomId}`);
    return;
  }

  // Get title if not cached. SoundCloud playlist/set entries also carry no
  // title from flat-playlist resolution, and their stored url may still be the
  // internal api-v2 url yt-dlp's flat-playlist gave us — resolving here also
  // self-heals it to the public webpage_url.
  if (!nextSong.title) {
    if (nextSong.source === "soundcloud") {
      const info = await resolveSoundcloudTrack(nextSong.url);
      if (info) {
        db.update(songs)
          .set({ title: info.title, uploader: info.uploader, thumbnail: info.thumbnail, url: info.url })
          .where(eq(songs.id, nextSong.id))
          .run();
        nextSong.title = info.title;
        nextSong.url = info.url;
      }
    } else {
      const { title, uploader } = await getVideoInfo(nextSong.url);
      db.update(songs)
        .set({ title, uploader })
        .where(eq(songs.id, nextSong.id))
        .run();
      nextSong.title = title;
    }
  }

  const connection = connections.get(guildId);
  if (!connection) {
    console.log(`❌ No voice connection for guild ${guildId}`);
    return;
  }

  // Kill any still-running processes from a previous track before starting.
  currentTracks.get(guildId)?.cleanup();

  console.log(`▶️ Playing in room ${roomId}: ${nextSong.title || nextSong.videoId}`);

  const { resource, cleanup } = createAudioStream(nextSong.url);
  const player = setupPlayer(guildId);

  player.play(resource);
  connection.subscribe(player);

  currentTracks.set(guildId, {
    songId: nextSong.id,
    videoId: nextSong.videoId,
    startedAt: Date.now(),
    cleanup,
  });
}

// --- Hono API ---
const app = new Hono();

// Skip request logging for the high-frequency songs poll: every connected client
// hits it every ~4s, so logging it floods stdout and the json-file log driver.
const requestLogger = logger();
app.use("*", (c, next) =>
  c.req.method === "GET" && /\/songs$/.test(c.req.path) ? next() : requestLogger(c, next)
);
app.use(
  "*",
  cors({
    // Same-origin requests (no Origin header) always pass. Beyond that, allow
    // the configured public origins, plus localhost/LAN only outside prod.
    origin: (origin) => {
      if (!origin) return origin;
      if (CORS_ALLOWED_ORIGINS.has(origin)) return origin;
      if (
        !IS_PROD &&
        /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+)(:\d+)?$/.test(origin)
      )
        return origin;
      return null;
    },
    credentials: true,
  })
);

// Centralised error + 404 handling so an unexpected throw returns a clean 500
// (and is logged) instead of leaking a stack trace.
app.onError((err, c) => {
  console.error(`✖ ${c.req.method} ${c.req.path} —`, err);
  return c.json({ error: "Internal server error" }, 500);
});
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Liveness + readiness for orchestrator / proxy health checks.
app.get("/health", (c) => c.json({ ok: true }));
app.get("/ready", async (c) => {
  try {
    await db.run(sql`SELECT 1`);
    return c.json({ ok: true, discord: discord.isReady() });
  } catch {
    return c.json({ ok: false }, 503);
  }
});

// Bot invite: redirect to Discord's OAuth2 bot authorization page with the
// minimum permissions the bot needs — view channels + send messages for slash
// commands, connect/speak/use-VAD for voice playback. Exposed as a redirect so
// the frontend links here instead of duplicating the client id and permission
// bitfield.
app.get("/api/bot/invite", (c) => {
  const permissions = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.Connect,
    PermissionsBitField.Flags.Speak,
    PermissionsBitField.Flags.UseVAD,
  ]);
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", DISCORD_CLIENT_ID!);
  url.searchParams.set("permissions", String(permissions.bitfield));
  url.searchParams.set("scope", "bot applications.commands");
  return c.redirect(url.toString());
});

// `source` picks how each flat-playlist entry's url is built: YouTube entries
// reliably carry only an id, so the canonical watch url is reconstructed;
// SoundCloud flat-playlist entries carry their own (sometimes internal API,
// not the public webpage) url and never a title — titles for those are filled
// in lazily by playNextFromRoomInner, same as any song missing a title.
async function resolvePlaylist(
  url: string,
  source: Source
): Promise<{ title: string; entries: Array<{ videoId: string; title: string | null; url: string }> } | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "yt-dlp",
      ["--flat-playlist", "--dump-single-json", "--no-warnings", ...YTDLP_BASE_ARGS, url],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }
    );
    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    proc.on("close", () => {
      try {
        const data = JSON.parse(output.trim());
        const entries = (data.entries || [])
          .filter((e: any) => e.id)
          .map((e: any) => ({
            videoId: String(e.id),
            title: e.title ? String(e.title) : null,
            url: source === "youtube"
              ? `https://www.youtube.com/watch?v=${e.id}`
              : String(e.webpage_url || e.url || ""),
          }))
          .filter((e: { url: string }) => e.url);
        resolve({ title: data.title || "Playlist", entries });
      } catch {
        resolve(null);
      }
    });
    proc.on("error", () => resolve(null));
  });
}

// ==================== AUTH ====================

app.get("/auth/discord", (c) => {
  // CSRF protection: bind this authorize request to the callback via a random
  // state stored in a short-lived, http-only cookie.
  const state = crypto.randomUUID();
  setCookie(c, "b2b_oauth_state", state, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });

  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", DISCORD_CLIENT_ID!);
  url.searchParams.set("redirect_uri", DISCORD_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

app.get("/auth/discord/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const cookieState = getCookie(c, "b2b_oauth_state");
  // One-time use: clear the state cookie regardless of outcome.
  setCookie(c, "b2b_oauth_state", "", { maxAge: 0, path: "/" });
  if (!state || !cookieState || state !== cookieState)
    return c.redirect(`${FRONTEND_URL}?error=state_mismatch`);
  if (!code) return c.redirect(`${FRONTEND_URL}?error=no_code`);

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: DISCORD_CLIENT_ID!,
      client_secret: DISCORD_CLIENT_SECRET!,
      grant_type: "authorization_code",
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token)
    return c.redirect(`${FRONTEND_URL}?error=token_failed`);

  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  const discordUser = await userRes.json();

  const avatarUrl = discordUser.avatar
    ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
    : null;

  // We only need identity; the Discord access/refresh tokens are never used
  // again, so they are intentionally not persisted (data minimisation).
  await db
    .insert(users)
    .values({
      id: discordUser.id,
      username: discordUser.username,
      avatar: avatarUrl,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        username: discordUser.username,
        avatar: avatarUrl,
      },
    });

  // Stamp the current token version into the JWT so a later logout (which bumps
  // it) invalidates this token.
  const dbUser = await db
    .select({ tokenVersion: users.tokenVersion })
    .from(users)
    .where(eq(users.id, discordUser.id))
    .get();

  const token = await encodeJwt(
    {
      sub: discordUser.id,
      username: discordUser.username,
      avatar: avatarUrl,
      tv: dbUser?.tokenVersion ?? 0,
    },
    JWT_SECRET,
    TOKEN_TTL_SECONDS
  );

  setCookie(c, "b2b_token", token, {
    httpOnly: true,
    secure: IS_PROD, // HTTPS-only in production
    sameSite: "Lax",
    path: "/",
    maxAge: TOKEN_TTL_SECONDS,
  });

  return c.redirect(FRONTEND_URL);
});

app.get("/api/auth/me", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ user: null });
  return c.json({
    user: {
      id: user.id,
      username: user.username,
      avatar: user.avatar,
      isAdmin: isAdmin(user),
    },
  });
});

app.get("/auth/logout", async (c) => {
  // Bump tokenVersion so any outstanding JWTs for this user stop validating —
  // real revocation, not just clearing this browser's cookie.
  const user = await getUser(c);
  if (user) {
    await db
      .update(users)
      .set({ tokenVersion: (user.tokenVersion ?? 0) + 1 })
      .where(eq(users.id, user.id))
      .run();
  }
  setCookie(c, "b2b_token", "", { maxAge: 0, path: "/" });
  return c.redirect(FRONTEND_URL);
});

// ==================== ROOMS ====================

// Track which room each Discord user is viewing
const userCurrentRoom = new Map<string, string>(); // userId -> roomId

// Read-only: a GET must not create or mutate a room (that would let a read
// acquire ownership). Room rows are created by write paths (presence, song
// POST, Discord /play).
app.get("/api/rooms/:id", async (c) => {
  const { id } = c.req.param();
  const user = await getUser(c);
  const room = await db.select().from(rooms).where(eq(rooms.id, id)).get();
  const canDelete =
    isAdmin(user) || (!!user && !!room?.createdBy && room.createdBy === user.id);
  return c.json({
    id,
    name: room?.name ?? null,
    createdBy: room?.createdBy ?? null,
    createdAt: room?.createdAt ?? null,
    lastActivityAt: room?.lastActivityAt ?? null,
    exists: !!room,
    canDelete,
    isAdmin: isAdmin(user),
  });
});

// Set / clear the user's current room (called from frontend).
// A null or absent roomId means the user left the room, so we drop the mapping
// and the Discord bot falls back to the guild as the default room.
app.post("/api/user/room", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const roomId: string | null = body?.roomId ?? null;

  if (roomId) {
    userCurrentRoom.set(user.id, roomId);
    const room = await ensureRoom(roomId, user.id);
    const canDelete =
      isAdmin(user) || (!!room?.createdBy && room.createdBy === user.id);
    console.log(`📍 User ${user.username} now in room ${roomId}`);
    return c.json({ success: true, roomId, canDelete });
  }

  userCurrentRoom.delete(user.id);
  console.log(`🚪 User ${user.username} left their room`);
  return c.json({ success: true, roomId: null });
});

app.get("/api/rooms/:id/songs", async (c) => {
  const { id } = c.req.param();
  const user = await getUser(c);

  const roomSongs = await db
    .select()
    .from(songs)
    .where(eq(songs.roomId, id))
    .orderBy(desc(songs.votes), songs.createdAt)
    .all();

  let userVotes: number[] = [];
  if (user) {
    // Scope to this room's songs (join) so the result is bounded by the room,
    // not the user's entire vote history across every room they've ever used.
    const userVoteRecords = await db
      .select({ songId: votes.songId })
      .from(votes)
      .innerJoin(songs, eq(votes.songId, songs.id))
      .where(and(eq(votes.userId, user.id), eq(songs.roomId, id)))
      .all();
    userVotes = userVoteRecords.map((v) => v.songId);
  }

  const presentCount = [...userCurrentRoom.values()].filter((r) => r === id).length;

  const guildId = [...guildRoomMap.entries()].find(([, r]) => r === id)?.[0];
  const track = guildId ? currentTracks.get(guildId) : null;
  const currentSongStartedAt = track?.startedAt ?? null;
  // The song actually streaming, not just the highest-voted unplayed one —
  // those diverge once a pending song's votes overtake the one already
  // playing (it stays played=false until it finishes). null when nothing is
  // actively streaming (bot not connected yet), so the frontend can fall back
  // to the vote-order heuristic in that case.
  const currentSongId = track?.songId ?? null;

  return c.json({ songs: roomSongs, userVotes, presentCount, currentSongStartedAt, currentSongId });
});

app.post("/api/rooms/:id/songs", async (c) => {
  const { id } = c.req.param();
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);
  if (!rateLimit(`songs:${clientKey(c)}`, 30, 60_000))
    return c.json({ error: "Too many requests" }, 429);

  const body = await c.req.json();
  const { url } = body;

  const source = detectSource(url);
  if (!source) return c.json({ error: "Invalid YouTube or SoundCloud URL" }, 400);

  await ensureRoom(id, user.id);

  if (isPlaylistUrl(url) || isSoundcloudSetUrl(url)) {
    const playlist = await resolvePlaylist(url, source);
    if (!playlist || playlist.entries.length === 0)
      return c.json({ error: "Could not resolve playlist" }, 400);

    const playlistId = crypto.randomUUID();
    await db.insert(songs).values(
      playlist.entries.map((e) => ({
        roomId: id,
        videoId: e.videoId,
        source,
        url: e.url,
        title: e.title,
        addedBy: user.username,
        addedByUserId: user.id,
        playlistId,
        playlistTitle: playlist.title,
      }))
    );

    for (const [guildId, roomId] of guildRoomMap) {
      if (roomId === id && connections.has(guildId) && !currentTracks.has(guildId)) {
        playNextFromRoom(id, guildId);
        break;
      }
    }

    console.log(`📋 Playlist "${playlist.title}" (${playlist.entries.length} songs) added to room ${id}`);
    return c.json({ playlistId, count: playlist.entries.length }, 201);
  }

  const resolved = await resolveSingleTrack(url, source);
  if (!resolved) return c.json({ error: "Could not resolve track" }, 400);

  const song = await db
    .insert(songs)
    .values({
      roomId: id,
      videoId: resolved.videoId,
      source,
      url: resolved.url,
      title: resolved.title,
      uploader: resolved.uploader,
      thumbnail: resolved.thumbnail,
      addedBy: user.username,
      addedByUserId: user.id,
    })
    .returning()
    .get();

  for (const [guildId, roomId] of guildRoomMap) {
    if (roomId === id && connections.has(guildId) && !currentTracks.has(guildId)) {
      playNextFromRoom(id, guildId);
      break;
    }
  }

  return c.json(song, 201);
});

app.post("/api/rooms/:id/songs/:songId/vote", async (c) => {
  const { songId } = c.req.param();
  const user = await getUser(c);

  if (!user) return c.json({ error: "Login required to vote" }, 401);

  const song = await db
    .select()
    .from(songs)
    .where(eq(songs.id, Number(songId)))
    .get();
  if (!song) return c.json({ error: "Song not found" }, 404);

  const existingVote = await db
    .select()
    .from(votes)
    .where(and(eq(votes.songId, Number(songId)), eq(votes.userId, user.id)))
    .get();

  if (existingVote) return c.json({ error: "Already voted" }, 409);

  await db.insert(votes).values({ songId: Number(songId), userId: user.id });

  const updated = await db
    .update(songs)
    .set({ votes: song.votes! + 1 })
    .where(eq(songs.id, Number(songId)))
    .returning()
    .get();

  return c.json(updated);
});

// Skip the current song. Requires votes >= skipThreshold(presentCount).
// The threshold is enforced server-side so the frontend can't bypass it.
app.post("/api/rooms/:id/skip", async (c) => {
  const { id } = c.req.param();
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);

  const presentCount = [...userCurrentRoom.values()].filter((r) => r === id).length;
  const threshold = skipThreshold(presentCount);

  const guildId = [...guildRoomMap.entries()].find(([, r]) => r === id)?.[0];
  const track = guildId ? currentTracks.get(guildId) : null;

  // Anchor to the song actually streaming (currentTracks), not the
  // highest-voted unplayed one — those diverge once a pending song's votes
  // overtake the one already playing (it stays played=false until it
  // finishes), which would otherwise let a vote-skip mark the wrong song
  // played while the real track keeps streaming. Fall back to the vote-order
  // pick only when nothing is actively streaming (bot not connected).
  const current = track
    ? await db.select().from(songs).where(eq(songs.id, track.songId)).get()
    : await db
        .select()
        .from(songs)
        .where(and(eq(songs.roomId, id), eq(songs.played, false)))
        .orderBy(desc(songs.votes), songs.createdAt)
        .get();

  if (!current) return c.json({ error: "Nothing playing" }, 404);
  const isOwner = current.addedByUserId === user.id;
  if (!isOwner && current.votes < threshold) return c.json({ error: "Not enough votes", votes: current.votes, threshold }, 403);

  // Mark as played before stopping the player so the DB is consistent when the
  // frontend refetches. The Idle handler will try to mark it again — harmless.
  await db.update(songs).set({ played: true }).where(eq(songs.id, current.id)).run();

  if (guildId) {
    recentSkip.add(guildId);
    players.get(guildId)?.stop();
  }

  console.log(`⏭️ Song "${current.title}" skipped in room ${id} by ${user.username} (${current.votes}/${threshold} votes)`);
  return c.json({ success: true });
});

// Skip all remaining songs in a playlist. Only the user who added the playlist
// or an admin can do this — it's a bulk action that bypasses per-song voting.
app.post("/api/rooms/:id/playlists/:playlistId/skip", async (c) => {
  const { id, playlistId } = c.req.param();
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);

  const playlistSongs = await db
    .select()
    .from(songs)
    .where(and(eq(songs.roomId, id), eq(songs.playlistId, playlistId), eq(songs.played, false)))
    .all();

  if (playlistSongs.length === 0) return c.json({ error: "No pending songs in playlist" }, 404);

  const isOwner = playlistSongs[0].addedByUserId === user.id;
  if (!isOwner && !isAdmin(user)) return c.json({ error: "Not authorized" }, 403);

  const ids = playlistSongs.map((s) => s.id);
  await db.update(songs).set({ played: true }).where(inArray(songs.id, ids)).run();

  // Stop the player if the current track belongs to this playlist.
  for (const [guildId, roomId] of guildRoomMap) {
    if (roomId === id) {
      const track = currentTracks.get(guildId);
      if (track && ids.includes(track.songId)) {
        recentSkip.add(guildId);
        players.get(guildId)?.stop();
      }
      break;
    }
  }

  console.log(`⏭️ Playlist "${playlistSongs[0].playlistTitle}" skipped in room ${id} by ${user.username}`);
  return c.json({ success: true, skipped: ids.length });
});

app.delete("/api/rooms/:id/songs/:songId", async (c) => {
  const { songId } = c.req.param();
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);

  const song = await db
    .select()
    .from(songs)
    .where(eq(songs.id, Number(songId)))
    .get();
  if (!song) return c.json({ error: "Song not found" }, 404);

  // Deny by default: only the song's adder or a global admin may delete it.
  const isOwner = !!song.addedByUserId && song.addedByUserId === user.id;
  if (!isOwner && !isAdmin(user)) {
    return c.json({ error: "Not authorized" }, 403);
  }

  await db.transaction(async (tx) => {
    await tx.delete(votes).where(eq(votes.songId, Number(songId)));
    await tx.delete(songs).where(eq(songs.id, Number(songId)));
  });
  return c.json({ success: true });
});

// Delete a whole room. Allowed for the room owner or a global admin.
app.delete("/api/rooms/:id", async (c) => {
  const { id } = c.req.param();
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);

  const room = await db.select().from(rooms).where(eq(rooms.id, id)).get();
  if (!room) return c.json({ error: "Room not found" }, 404);

  const isOwner = !!room.createdBy && room.createdBy === user.id;
  if (!isOwner && !isAdmin(user)) {
    return c.json({ error: "Not authorized" }, 403);
  }

  // Atomic cascade (votes -> songs -> room) so a crash can't leave a
  // half-deleted room. FKs are enforced by libSQL, hence the explicit order.
  const roomSongs = await db
    .select({ id: songs.id })
    .from(songs)
    .where(eq(songs.roomId, id))
    .all();
  const songIds = roomSongs.map((s) => s.id);
  await db.transaction(async (tx) => {
    if (songIds.length > 0) {
      await tx.delete(votes).where(inArray(votes.songId, songIds));
      await tx.delete(songs).where(eq(songs.roomId, id));
    }
    await tx.delete(rooms).where(eq(rooms.id, id));
  });

  // Tear down any live presence / Discord playback bound to this room.
  for (const [uid, rid] of userCurrentRoom) {
    if (rid === id) userCurrentRoom.delete(uid);
  }
  for (const [guildId, rid] of guildRoomMap) {
    if (rid === id) teardownGuild(guildId);
  }

  console.log(
    `🗑️ Room ${id} deleted by ${user.username}${
      isOwner ? " (owner)" : " (admin)"
    }`
  );
  return c.json({ success: true });
});

// ==================== SEARCH ====================

app.get("/api/search", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);
  if (!rateLimit(`search:${clientKey(c)}`, 20, 60_000))
    return c.json({ error: "Too many requests" }, 429);

  const q = (c.req.query("q") || "").trim();
  if (!q) return c.json({ results: [] });

  const n = Math.min(Number(c.req.query("n") || 5), 10);
  const source: Source = c.req.query("source") === "soundcloud" ? "soundcloud" : "youtube";
  const searchPrefix = source === "youtube" ? "ytsearch" : "scsearch";

  type SearchResult = {
    source: Source;
    videoId: string;
    title: string;
    duration: number | null;
    uploader: string | null;
    url: string;
    thumbnail: string | null;
  };
  const results = await new Promise<SearchResult[]>((resolve) => {
    const proc = spawn(
      "yt-dlp",
      [`${searchPrefix}${n}:${q}`, "--dump-json", "--flat-playlist", "--no-warnings", ...YTDLP_BASE_ARGS],
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
    c.req.raw.signal?.addEventListener("abort", () => {
      try { proc.kill("SIGKILL"); } catch {}
      finish([]);
    });
  });

  return c.json({ results });
});

// Connect the bot to wherever the authenticated user is currently in voice.
// A Discord user can only be in one voice channel at a time, so we iterate
// the bot's guilds until we find their voice state.
app.post("/api/rooms/:id/connect", async (c) => {
  const { id } = c.req.param();
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);

  let foundGuildId: string | null = null;
  let foundChannelId: string | null = null;
  let foundChannelName: string | null = null;

  for (const guild of discord.guilds.cache.values()) {
    const vs = guild.voiceStates.cache.get(user.id);
    if (vs?.channel) {
      foundGuildId = guild.id;
      foundChannelId = vs.channel.id;
      foundChannelName = vs.channel.name;
      break;
    }
  }

  if (!foundGuildId || !foundChannelId) {
    return c.json({ error: "Not in a voice channel" }, 404);
  }

  await ensureRoom(id, user.id);
  guildRoomMap.set(foundGuildId, id);
  await connectToVoiceChannel(foundGuildId, foundChannelId);
  await playNextFromRoom(id, foundGuildId);

  console.log(`🔊 Bot summoned by ${user.username} to ${foundChannelName} (guild ${foundGuildId})`);
  return c.json({ success: true, channelName: foundChannelName });
});

// ==================== ADMIN / MODERATION ====================

// Lightweight operational metrics. Admin-only (scrape with the admin cookie).
app.get("/metrics", async (c) => {
  const user = await getUser(c);
  if (!isAdmin(user)) return c.json({ error: "Not authorized" }, 403);
  const roomCount =
    (await db.select({ c: sql<number>`count(*)` }).from(rooms).get())?.c ?? 0;
  return c.json({
    rooms: Number(roomCount),
    voiceConnections: connections.size,
    tracksPlaying: currentTracks.size,
    usersPresent: userCurrentRoom.size,
    rateBuckets: rateBuckets.size,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// List every room with moderation metadata. Admin-only.
app.get("/api/admin/rooms", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);
  if (!isAdmin(user)) return c.json({ error: "Not authorized" }, 403);

  const allRooms = await db
    .select()
    .from(rooms)
    .orderBy(desc(rooms.lastActivityAt))
    .all();

  // Song counts per room in one grouped query (avoid N+1).
  const counts = await db
    .select({
      roomId: songs.roomId,
      total: sql<number>`count(*)`,
      pending: sql<number>`sum(case when coalesce(${songs.played}, 0) = 0 then 1 else 0 end)`,
    })
    .from(songs)
    .groupBy(songs.roomId)
    .all();
  const countByRoom = new Map(counts.map((r) => [r.roomId, r]));

  // Live presence (in-memory): users currently viewing each room.
  const presentByRoom = new Map<string, number>();
  for (const roomId of userCurrentRoom.values()) {
    presentByRoom.set(roomId, (presentByRoom.get(roomId) ?? 0) + 1);
  }

  // Resolve owner usernames in one query.
  const ownerIds = [
    ...new Set(allRooms.map((r) => r.createdBy).filter(Boolean) as string[]),
  ];
  const owners = ownerIds.length
    ? await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, ownerIds))
        .all()
    : [];
  const ownerName = new Map(owners.map((o) => [o.id, o.username]));

  const list = allRooms.map((room) => ({
    id: room.id,
    createdBy: room.createdBy,
    ownerName: room.createdBy ? ownerName.get(room.createdBy) ?? null : null,
    songCount: Number(countByRoom.get(room.id)?.total ?? 0),
    pendingCount: Number(countByRoom.get(room.id)?.pending ?? 0),
    presentCount: presentByRoom.get(room.id) ?? 0,
    lastActivityAt: room.lastActivityAt,
    createdAt: room.createdAt,
  }));

  return c.json({ rooms: list, count: list.length });
});

// List every guild with approval status. Admin-only.
app.get("/api/admin/guilds", async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);
  if (!isAdmin(user)) return c.json({ error: "Not authorized" }, 403);

  const allGuilds = await db.select().from(guilds).orderBy(desc(guilds.requestedAt)).all();
  return c.json({ guilds: allGuilds });
});

// Approve a pending guild — the bot becomes active there.
app.post("/api/admin/guilds/:guildId/approve", async (c) => {
  const { guildId } = c.req.param();
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);
  if (!isAdmin(user)) return c.json({ error: "Not authorized" }, 403);

  await db
    .update(guilds)
    .set({ approved: true, approvedAt: nowSeconds() })
    .where(eq(guilds.id, guildId))
    .run();
  console.log(`✅ Guild ${guildId} approved by ${user.username}`);
  return c.json({ success: true });
});

// Reject a guild — removes the record and leaves the Discord server.
app.post("/api/admin/guilds/:guildId/reject", async (c) => {
  const { guildId } = c.req.param();
  const user = await getUser(c);
  if (!user) return c.json({ error: "Login required" }, 401);
  if (!isAdmin(user)) return c.json({ error: "Not authorized" }, 403);

  await db.delete(guilds).where(eq(guilds.id, guildId)).run();
  teardownGuild(guildId);
  const guild = discord.guilds.cache.get(guildId);
  if (guild) {
    try { await guild.leave(); } catch (e) { console.error(`Failed to leave guild ${guildId}:`, e); }
  }
  console.log(`❌ Guild ${guildId} rejected by ${user.username}`);
  return c.json({ success: true });
});

// ==================== STATIC FILES (merged web) ====================
// In production the Vite-built frontend is bundled into the server image.
// Serve it as static files with SPA fallback for client-side routing.
if (IS_PROD) {
  const API_PREFIXES = ["/api", "/auth", "/health", "/ready", "/metrics"];
  app.get("*", async (c) => {
    const p = c.req.path;
    if (API_PREFIXES.some((prefix) => p.startsWith(prefix))) {
      return c.json({ error: "Not found" }, 404);
    }
    const file = Bun.file(path.join(WEB_DIST_DIR, p));
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(INDEX_HTML));
  });
}

// ==================== DISCORD BOT ====================

discord.once(Events.ClientReady, async (c) => {
  console.log(`🤖 Discord bot ready as ${c.user.tag}`);
  // Register slash commands on every boot so fresh deploys and newly-invited
  // guilds always have them. Idempotent: each PUT overwrites the global set.
  try {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN!);
    await rest.put(Routes.applicationCommands(c.application.id), {
      body: commands,
    });
    console.log(`✅ Registered ${commands.length} slash commands`);
  } catch (err) {
    console.error("Failed to register slash commands:", err);
  }

  // Register existing guilds. Legacy guilds (in cache but not yet in DB)
  // are auto-approved so upgrading is painless — only newly-invited guilds
  // start as pending.
  for (const guild of c.guilds.cache.values()) {
    const existing = await db.select().from(guilds).where(eq(guilds.id, guild.id)).get();
    if (!existing) {
      await db.insert(guilds).values({
        id: guild.id,
        name: guild.name,
        approved: true,
        approvedAt: nowSeconds(),
      }).run();
    }
  }
});

// New guilds start as pending approval — the bot joins but stays dormant
// (InteractionCreate gates on the guilds.approved flag).
discord.on(Events.GuildCreate, async (guild) => {
  const existing = await db.select().from(guilds).where(eq(guilds.id, guild.id)).get();
  if (!existing) {
    await db.insert(guilds).values({
      id: guild.id,
      name: guild.name,
      approved: false,
      requestedAt: nowSeconds(),
    }).run();
    console.log(`📋 Guild "${guild.name}" (${guild.id}) pending approval`);
  }
});

// Clean up when the bot is kicked from a guild.
discord.on(Events.GuildDelete, async (guild) => {
  await db.delete(guilds).where(eq(guilds.id, guild.id)).run();
  teardownGuild(guild.id);
  console.log(`🗑️ Guild "${guild.name}" (${guild.id}) removed`);
});

discord.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { guildId } = interaction;

  // Gate on guild approval: pending or unknown guilds can't use bot commands.
  if (guildId) {
    const guildRecord = await db.select().from(guilds).where(eq(guilds.id, guildId)).get();
    if (!guildRecord || !guildRecord.approved) {
      await interaction.reply({ content: "⏳ This server is pending admin approval.", ephemeral: true });
      return;
    }
  }

  try {
    if (interaction.commandName === "play") {
      const url = interaction.options.getString("url");
      if (!url || !guildId) {
        await interaction.reply("Provide a YouTube or SoundCloud URL and be in a server");
        return;
      }
      const source = detectSource(url);
      if (!source) {
        await interaction.reply("Invalid YouTube or SoundCloud URL");
        return;
      }

      const voiceChannel = interaction.member?.voice?.channel as
        | VoiceBasedChannel
        | null
        | undefined;
      if (!voiceChannel) {
        await interaction.reply("You need to be in a voice channel!");
        return;
      }

      await interaction.deferReply();

      const roomId = guildRoomMap.get(guildId) || userCurrentRoom.get(interaction.user.id) || guildId;

      await ensureRoom(roomId, interaction.user.id);

      const resolved = await resolveSingleTrack(url, source);
      if (!resolved) {
        await interaction.editReply("Could not resolve track");
        return;
      }
      const { title, uploader, thumbnail } = resolved;

      await db.insert(songs).values({
        roomId,
        videoId: resolved.videoId,
        source,
        url: resolved.url,
        title,
        uploader,
        thumbnail,
        addedBy: interaction.user.username,
        addedByUserId: interaction.user.id,
      });

      await new Promise((r) => setTimeout(r, 50));

      guildRoomMap.set(guildId, roomId);
      await connectToVoiceChannel(guildId, voiceChannel.id);
      await playNextFromRoom(roomId, guildId);

      await interaction.editReply(`Added to queue: **${title || url}**`);
    }

    if (interaction.commandName === "listen") {
      if (!guildId) return;
      const voiceChannel = interaction.member?.voice?.channel as
        | VoiceBasedChannel
        | null
        | undefined;
      if (!voiceChannel) {
        await interaction.reply("You need to be in a voice channel!");
        return;
      }

      await interaction.deferReply();

      const roomId = guildRoomMap.get(guildId) || userCurrentRoom.get(interaction.user.id) || guildId;

      guildRoomMap.set(guildId, roomId);
      await connectToVoiceChannel(guildId, voiceChannel.id);
      await playNextFromRoom(roomId, guildId);

      const roomMsg = roomId !== guildId ? `room **${roomId}**` : "this server";
      await interaction.editReply(`▶️ Starting queue from ${roomMsg}...`);
    }

    if (interaction.commandName === "stop") {
      if (!guildId) return;
      teardownGuild(guildId);
      await interaction.reply("⏹️ Stopped");
    }

    if (interaction.commandName === "skip") {
      if (!guildId) return;
      const player = players.get(guildId);
      if (player) {
        recentSkip.add(guildId);
        player.stop();
      }
      await interaction.reply("⏭️ Skipped");
    }

    if (interaction.commandName === "queue") {
      if (!guildId) return;
      const roomId = guildRoomMap.get(guildId) || guildId;

      const queue = db
        .select()
        .from(songs)
        .where(eq(songs.roomId, roomId))
        .orderBy(desc(songs.votes), songs.createdAt)
        .all()
        .filter((s) => !s.played);

      if (queue.length === 0) {
        await interaction.reply("📭 Queue is empty");
        return;
      }

      const list = queue
        .map(
          (s, i) =>
            `${i + 1}. **${s.title || s.videoId}** (votes: ${s.votes}) — by ${s.addedBy}`
        )
        .join("\n");

      await interaction.reply(`🎵 **Queue:**\n${list}`);
    }

    if (interaction.commandName === "reset") {
      if (!guildId) return;
      const roomId = guildRoomMap.get(guildId) || guildId;

      await db.update(songs).set({ played: false }).where(eq(songs.roomId, roomId)).run();
      await interaction.reply("🔄 Queue reset — all songs are now playable");
    }
  } catch (err) {
    console.error(`Interaction '${interaction.commandName}' failed:`, err);
    try {
      const msg = "⚠️ Something went wrong handling that command.";
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else if (interaction.isRepliable()) await interaction.reply(msg);
    } catch {}
  }
});

// --- Periodic maintenance ---
// Reap rooms that hold no songs, have nobody present, and have been idle past
// the TTL. Auto-created rooms (a visit upserts the row) would otherwise pile up.
async function gcEmptyRooms() {
  const cutoff = nowSeconds() - Math.floor(ROOM_TTL_MS / 1000);
  const present = new Set(userCurrentRoom.values());
  const allRooms = await db.select().from(rooms).all();

  // Which rooms hold songs? One query instead of one-per-room.
  const nonEmpty = new Set(
    (await db.selectDistinct({ roomId: songs.roomId }).from(songs).all()).map(
      (r) => r.roomId
    )
  );

  const stale = allRooms.filter((room) => {
    const lastActivity = room.lastActivityAt ?? room.createdAt ?? 0;
    return (
      lastActivity <= cutoff && !present.has(room.id) && !nonEmpty.has(room.id)
    );
  });

  for (const room of stale) {
    await db.delete(rooms).where(eq(rooms.id, room.id));
  }

  if (stale.length > 0)
    console.log(`🧹 GC: removed ${stale.length} empty stale room(s)`);
}

// Purge played songs (and their votes) older than the TTL so songs/votes don't
// grow without bound in long-lived, active rooms.
async function purgePlayedSongs() {
  const cutoff = nowSeconds() - Math.floor(PLAYED_SONG_TTL_MS / 1000);
  const old = await db
    .select({ id: songs.id })
    .from(songs)
    .where(and(eq(songs.played, true), lt(songs.createdAt, cutoff)))
    .all();
  if (old.length === 0) return;
  const ids = old.map((s) => s.id);
  await db.transaction(async (tx) => {
    await tx.delete(votes).where(inArray(votes.songId, ids));
    await tx.delete(songs).where(inArray(songs.id, ids));
  });
  console.log(`🧹 GC: purged ${ids.length} old played song(s)`);
}

function pruneRateBuckets() {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(k);
}

async function runMaintenance() {
  try { await gcEmptyRooms(); } catch (e) { console.error("gcEmptyRooms failed:", e); }
  try { await purgePlayedSongs(); } catch (e) { console.error("purgePlayedSongs failed:", e); }
  pruneRateBuckets();
}

setInterval(runMaintenance, 60 * 60 * 1000); // hourly
setTimeout(() => void runMaintenance(), 30_000); // once, shortly after boot

// --- Voice-channel reaping ---
// If the queue has been empty (and nothing playing) for EMPTY_QUEUE_LEAVE_MS,
// or the bot has been alone in the voice channel for ALONE_LEAVE_MS, leave so
// the bot isn't parked in a channel consuming a slot for no reason.
function isAloneInVoice(guildId: string): boolean {
  const conn = connections.get(guildId);
  if (!conn) return false;
  const channelId = conn.joinConfig.channelId;
  if (!channelId) return false;
  const guild = discord.guilds.cache.get(guildId);
  if (!guild) return false;
  const botId = discord.user?.id;
  for (const vs of guild.voiceStates.cache.values()) {
    if (vs.channelId === channelId && vs.id !== botId) return false;
  }
  return true;
}

async function hasUnplayedSongs(roomId: string): Promise<boolean> {
  const row = await db
    .select({ c: sql<number>`count(*)` })
    .from(songs)
    .where(and(eq(songs.roomId, roomId), eq(songs.played, false)))
    .get();
  return (row?.c ?? 0) > 0;
}

async function reapIdleVoiceConnections() {
  const now = Date.now();
  for (const guildId of [...connections.keys()]) {
    const roomId = guildRoomMap.get(guildId);

    // Alone in the voice channel — leave quickly.
    if (isAloneInVoice(guildId)) {
      if (!aloneSince.has(guildId)) aloneSince.set(guildId, now);
      if (now - aloneSince.get(guildId)! >= ALONE_LEAVE_MS) {
        console.log(
          `👋 Bot alone in voice channel for ${ALONE_LEAVE_MS / 1000}s (guild ${guildId}); leaving.`
        );
        teardownGuild(guildId);
        continue;
      }
    } else {
      aloneSince.delete(guildId);
    }

    // Empty queue (and nothing currently playing) — leave after the grace period.
    if (!currentTracks.has(guildId) && roomId) {
      if (!(await hasUnplayedSongs(roomId))) {
        if (!emptySince.has(guildId)) emptySince.set(guildId, now);
        if (now - emptySince.get(guildId)! >= EMPTY_QUEUE_LEAVE_MS) {
          console.log(
            `📭 Queue empty for ${Math.round(EMPTY_QUEUE_LEAVE_MS / 60_000)}min (guild ${guildId}); leaving.`
          );
          teardownGuild(guildId);
          continue;
        }
      } else {
        emptySince.delete(guildId);
      }
    } else {
      emptySince.delete(guildId);
    }
  }
}

setInterval(() => void reapIdleVoiceConnections(), 15_000);

// --- Process-level safety nets ---
// A single unhandled error in an event handler must not take down the whole
// process (bot + API + every room). Log loudly and keep serving.
process.on("unhandledRejection", (reason) => console.error("unhandledRejection:", reason));
process.on("uncaughtException", (err) => {
  // EPIPE means a client disconnected mid-response; harmless, don't crash.
  if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
  console.error("uncaughtException:", err);
});

// --- Start ---
if (DISCORD_TOKEN) {
  discord.login(DISCORD_TOKEN);
} else {
  console.log("⚠️  No DISCORD_TOKEN set, bot not starting");
}

const server = serve({
  fetch: app.fetch,
  port: PORT,
  hostname: "0.0.0.0",
});

console.log(`🎵 Back2Back server running on http://localhost:${PORT}`);

// --- Graceful shutdown ---
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down…`);
  // Hard-exit backstop so a hung cleanup doesn't wait for Docker's SIGKILL.
  setTimeout(() => process.exit(1), 8_000).unref();
  for (const guildId of [...connections.keys()]) teardownGuild(guildId);
  try { await discord.destroy(); } catch {}
  try { await server.stop?.(true); } catch {}
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
