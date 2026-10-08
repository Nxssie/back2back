import { Hono } from "hono";
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
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
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
import { users, rooms, songs, votes, skipVotes, guilds, type Song } from "./db/schema";
import { eq, desc, and, inArray, lt, sql } from "drizzle-orm";
import { commands } from "./commands";
import { extractVideoId } from "./lib/youtube";
import { detectSource, type Source } from "./lib/sources";
import { skipThreshold } from "./lib/voting";
import { YTDLP_BASE_ARGS, YTDLP_DOWNLOAD_ARGS } from "./lib/ytdlp";
import { searchTracks, toSelectOptions, type SearchableSource } from "./lib/search";
import { encodeId, decodeId } from "./lib/components";
import { formatQueuePage, clampPage, slicePage, type QueueSong } from "./lib/queue";
import { fetchLyrics, formatLyrics } from "./lib/lyrics";

// --- Config ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const PORT = Number(process.env.PORT) || 3001;
// Bearer token gating the /metrics scrape endpoint. When unset the route is
// disabled entirely, so a missing secret fails closed instead of exposing
// operational counters.
const METRICS_TOKEN = process.env.METRICS_TOKEN;

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

// --- State (in-memory; this is a deliberately single-instance service) ---
const players = new Map<string, AudioPlayer>();
const connections = new Map<string, VoiceConnection>();
const guildRoomMap = new Map<string, string>();
// Where each guild's now-playing card lives. Discord gives no text channel for
// a voice channel, so the channel is remembered from whichever channel a
// command was used in, and the card is edited in place from track to track.
const guildTextChannel = new Map<string, string>();
const nowPlayingMessage = new Map<string, { channelId: string; messageId: string }>();
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
      "-vn",
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

// Single yt-dlp round trip for a Mixcloud track: id, title, uploader, and
// thumbnail. Mixcloud pages embed JSON-LD metadata that yt-dlp extracts
// reliably. Returns null on timeout/failure so callers can 400 instead of
// inserting a song with no usable metadata.
function resolveMixcloudTrack(url: string): Promise<{
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
          uploader: d.uploader ?? d.creator ?? null,
          thumbnail,
        });
      } catch {
        resolve(null);
      }
    });
    proc.on("error", () => resolve(null));
  });
}

// Single yt-dlp round trip for a Twitch VOD/clip: id, title, uploader, and
// thumbnail. Twitch URLs don't carry a parseable ID like YouTube, so we rely
// entirely on yt-dlp's --dump-json to extract metadata.
function resolveTwitchTrack(url: string): Promise<{
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
          uploader: d.uploader ?? d.channel ?? null,
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
  if (source === "mixcloud") return resolveMixcloudTrack(url);
  if (source === "twitch") return resolveTwitchTrack(url);
  if (source === "generic") {
    // Direct streaming manifest — yt-dlp handles HLS/DASH natively.
    // No parseable video ID; use a truncated SHA-256 of the URL.
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
    const { title, uploader } = await getVideoInfo(url);
    return { videoId: hash, url, title, uploader, thumbnail: null };
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
      await db.delete(skipVotes).where(eq(skipVotes.songId, track.songId)).run();
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

// The song actually streaming, else the vote-order pick when nothing is
// streaming (bot not connected) — the same anchor both skip routes use, so a
// pending song that overtook the playing one in votes cannot be marked played
// while the real track keeps streaming.
async function currentSongForRoom(roomId: string, guildId: string): Promise<Song | null> {
  const track = currentTracks.get(guildId);
  if (track) {
    return (await db.select().from(songs).where(eq(songs.id, track.songId)).get()) ?? null;
  }
  return (
    (await db
      .select()
      .from(songs)
      .where(and(eq(songs.roomId, roomId), eq(songs.played, false)))
      .orderBy(desc(songs.votes), songs.createdAt)
      .get()) ?? null
  );
}

async function skipVoteCount(songId: number): Promise<number> {
  return (
    await db.select({ c: sql<number>`count(*)` }).from(skipVotes).where(eq(skipVotes.songId, songId)).get()
  )?.c ?? 0;
}

// Mark played before stopping the player, the order both skip routes use, so
// the DB is already consistent when the Idle handler tries to mark it again.
async function markSkipped(guildId: string, songId: number): Promise<void> {
  await db.update(songs).set({ played: true }).where(eq(songs.id, songId)).run();
  await db.delete(skipVotes).where(eq(skipVotes.songId, songId)).run();
  recentSkip.add(guildId);
  players.get(guildId)?.stop();
}

function nowPlayingEmbed(song: Song): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(song.title?.trim() || song.videoId)
    .setURL(song.url)
    .setFooter({ text: song.addedBy ? `Added by ${song.addedBy}` : "Now playing" });
  const thumbnail =
    song.thumbnail ??
    (song.source === "youtube" ? `https://i.ytimg.com/vi/${song.videoId}/hqdefault.jpg` : null);
  return thumbnail ? embed.setThumbnail(thumbnail) : embed;
}

// The card follows the track: edit the previous one when it still exists,
// otherwise post a new one. No Discord failure here may disturb playback, which
// is already streaming by the time this runs.
async function publishNowPlaying(guildId: string, song: Song): Promise<void> {
  const channelId = guildTextChannel.get(guildId);
  if (!channelId) return;
  try {
    const channel = await discord.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    const payload = {
      embeds: [nowPlayingEmbed(song)],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(encodeId("p_skipvote", guildId))
            .setLabel("Vote skip")
            .setEmoji("🗳️")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(encodeId("p_skip", guildId))
            .setLabel("Skip")
            .setEmoji("⏭️")
            .setStyle(ButtonStyle.Secondary)
        ),
      ],
    };
    const previous = nowPlayingMessage.get(guildId);
    if (previous?.channelId === channelId) {
      const message = await channel.messages.fetch(previous.messageId).catch(() => null);
      if (message) {
        await message.edit(payload);
        return;
      }
    }
    const sent = await (channel as TextChannel).send(payload);
    nowPlayingMessage.set(guildId, { channelId, messageId: sent.id });
  } catch (err) {
    console.error(`⚠️ Could not publish the now-playing card for guild ${guildId}:`, err);
  }
}

async function playNextFromRoomInner(roomId: string, guildId: string) {
  // Don't clobber a track that's already streaming. The current song stays
  // `played = false` until it finishes, so without this guard we'd re-pick it
  // and restart from scratch — re-spawning yt-dlp + ffmpeg. The Idle handler
  // advances when the current track ends.
  if (currentTracks.has(guildId)) return;

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

  // Get title if not cached. SoundCloud, Mixcloud, and Twitch entries carry no title
  // from flat-playlist resolution, and their stored url may still be an
  // internal url — resolving here also self-heals it to the public webpage_url.
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
    } else if (nextSong.source === "mixcloud") {
      const info = await resolveMixcloudTrack(nextSong.url);
      if (info) {
        db.update(songs)
          .set({ title: info.title, uploader: info.uploader, thumbnail: info.thumbnail, url: info.url })
          .where(eq(songs.id, nextSong.id))
          .run();
        nextSong.title = info.title;
        nextSong.url = info.url;
      }
    } else if (nextSong.source === "twitch") {
      const info = await resolveTwitchTrack(nextSong.url);
      if (info) {
        db.update(songs)
          .set({ title: info.title, uploader: info.uploader, thumbnail: info.thumbnail, url: info.url })
          .where(eq(songs.id, nextSong.id))
          .run();
        nextSong.title = info.title;
        nextSong.url = info.url;
      }
    } else {
      // YouTube, generic HLS/DASH
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

  await publishNowPlaying(guildId, nextSong);
}

// --- Hono API ---
const app = new Hono();

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

// Operational metrics. Gated by a bearer token from METRICS_TOKEN; when the
// variable is unset the endpoint is disabled entirely (fail closed).
app.get("/metrics", async (c) => {
  if (!METRICS_TOKEN) return c.json({ error: "Metrics disabled" }, 403);
  if (c.req.header("authorization") !== `Bearer ${METRICS_TOKEN}`)
    return c.json({ error: "Not authorized" }, 403);
  const roomCount =
    (await db.select({ c: sql<number>`count(*)` }).from(rooms).get())?.c ?? 0;
  return c.json({
    rooms: Number(roomCount),
    voiceConnections: connections.size,
    tracksPlaying: currentTracks.size,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// Track which room each Discord user is viewing
const userCurrentRoom = new Map<string, string>(); // userId -> roomId

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
  guildTextChannel.delete(guild.id);
  nowPlayingMessage.delete(guild.id);
  console.log(`🗑️ Guild "${guild.name}" (${guild.id}) removed`);
});

// Queue a track for a guild: the voice gate, room resolution and play-order
// live here so /play and the /search picker cannot drift apart. Callers own
// URL/source validation and the interaction has already been acknowledged iff
// `interaction.replied`/`deferred` is set.
async function queueTrackForGuild(
  interaction: ChatInputCommandInteraction | StringSelectMenuInteraction,
  guildId: string,
  url: string,
  source: Source
) {
  const voiceChannel = interaction.member?.voice?.channel as VoiceBasedChannel | null | undefined;
  if (!voiceChannel) {
    if (interaction.deferred || interaction.replied) await interaction.editReply("You need to be in a voice channel!");
    else await interaction.reply("You need to be in a voice channel!");
    return;
  }

  if (!interaction.deferred && !interaction.replied) await interaction.deferReply();

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

  await interaction.editReply({ content: `Added to queue: **${title || url}**`, components: [] });
}

// The queue read-model every /queue surface shares: the unplayed, vote-ordered
// rows the HTTP songs route and auto-advance already use, so the command and
// its buttons, selects, and re-renders can never disagree about what is queued.
async function loadQueue(roomId: string): Promise<QueueSong[]> {
  const rows = await db
    .select()
    .from(songs)
    .where(eq(songs.roomId, roomId))
    .orderBy(desc(songs.votes), songs.createdAt)
    .all();
  return rows.filter((s) => !s.played);
}

// Rebuild the whole panel from a freshly loaded queue. A stale message left in
// a channel must never render or act on state the database no longer has.
function queuePanel(queue: QueueSong[], page: number, guildId: string, userId: string) {
  const view = formatQueuePage(queue, page);
  const pageSongs = slicePage(queue, view.page);

  const components: (
    | ActionRowBuilder<ButtonBuilder>
    | ActionRowBuilder<StringSelectMenuBuilder>
  )[] = [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeId("q_prev", view.page, guildId))
        .setLabel("◀ Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(view.page <= 1),
      new ButtonBuilder()
        .setCustomId(encodeId("q_refresh", view.page, guildId))
        .setLabel("🔄 Refresh")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(encodeId("q_next", view.page, guildId))
        .setLabel("Next ▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(view.page >= view.pageCount)
    ),
  ];

  // Discord rejects a select with zero options, so an empty page drops the row.
  if (pageSongs.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(encodeId("q_vote", view.page, guildId))
          .setPlaceholder("Upvote a song")
          .addOptions(
            pageSongs.map((s) => ({
              label: (s.title?.trim() || s.videoId).slice(0, 100),
              value: String(s.id),
            }))
          )
      )
    );
  }

  // Only the songs this user added are removable, and an empty select is
  // rejected by Discord — so omit the row entirely when the page has none.
  const mine = pageSongs.filter((s) => s.addedByUserId === userId);
  if (mine.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(encodeId("q_remove", view.page, guildId))
          .setPlaceholder("Remove one of your songs")
          .addOptions(
            mine.map((s) => ({
              label: (s.title?.trim() || s.videoId).slice(0, 100),
              value: String(s.id),
            }))
          )
      )
    );
  }

  return { embeds: [new EmbedBuilder().setDescription(view.text)], components };
}

// Moderation overview for /admin. Every render reads the DB fresh so an action
// never shows a list the database no longer has.
async function adminView() {
  const pending = await db
    .select()
    .from(guilds)
    .where(eq(guilds.approved, false))
    .orderBy(desc(guilds.requestedAt))
    .all();
  const roomCount = (await db.select({ c: sql<number>`count(*)` }).from(rooms).get())?.c ?? 0;
  const songCount = (await db.select({ c: sql<number>`count(*)` }).from(songs).get())?.c ?? 0;

  // Discord caps a select at 25 options, so the list is capped to match.
  const options = pending.slice(0, 25).map((g) => ({
    label: (g.name?.trim() || g.id).slice(0, 100),
    value: g.id,
  }));

  const lines = [
    `• Rooms: **${roomCount}**`,
    `• Songs: **${songCount}**`,
    `• Active voice connections: **${connections.size}**`,
    "",
    pending.length === 0
      ? "✅ No servers pending approval."
      : `**Pending servers (${pending.length})**\n${options.map((o) => `• ${o.label} \`${o.value}\``).join("\n")}`,
  ];

  // Discord rejects a select with zero options, so pending guilds add the rows.
  const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  if (options.length > 0) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(encodeId("a_approve")).setPlaceholder("Approve a server").addOptions(options)
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(encodeId("a_reject")).setPlaceholder("Reject a server").addOptions(options)
      )
    );
  }

  return { embeds: [new EmbedBuilder().setDescription(lines.join("\n"))], components };
}

discord.on(Events.InteractionCreate, async (interaction) => {
  if (
    !interaction.isChatInputCommand() &&
    !interaction.isStringSelectMenu() &&
    !interaction.isButton()
  )
    return;
  const { guildId } = interaction;
  // The now-playing card is posted to the last channel a command was used in.
  if (guildId) guildTextChannel.set(guildId, interaction.channelId);

  // Gate on guild approval: pending or unknown guilds can't use bot commands.
  // Admins are exempt because the web panel that approved guilds is going away
  // and /admin must be reachable inside a pending guild to bootstrap it.
  if (guildId && !ADMIN_DISCORD_IDS.has(interaction.user.id)) {
    const guildRecord = await db.select().from(guilds).where(eq(guilds.id, guildId)).get();
    if (!guildRecord || !guildRecord.approved) {
      await interaction.reply({ content: "⏳ This server is pending admin approval.", ephemeral: true });
      return;
    }
  }

  try {
    if (interaction.isStringSelectMenu()) {
      const decoded = decodeId(interaction.customId);
      if (decoded?.action === "search_pick") {
        // The URL is the payload, so this needs no server-side state and still
        // works after a restart. Drop the picker up front so it can't queue twice.
        const url = interaction.values[0];
        const source = url ? detectSource(url) : null;
        await interaction.update({ components: [] });
        if (!guildId || !url || !source) {
          await interaction.editReply({ content: "⚠️ That search result can no longer be played.", components: [] });
          return;
        }
        await queueTrackForGuild(interaction, guildId, url, source);
      }

      // /admin approve/reject selects. Reproduces the two HTTP admin routes
      // (POST /api/admin/guilds/:guildId/approve|reject) exactly, including the
      // fields they set and the kick on reject.
      if (decoded?.action === "a_approve" || decoded?.action === "a_reject") {
        if (!ADMIN_DISCORD_IDS.has(interaction.user.id)) {
          await interaction.reply({ content: "🚫 Not authorized.", ephemeral: true });
          return;
        }
        const target = interaction.values[0];
        if (!target) return;

        if (decoded.action === "a_approve") {
          await db
            .update(guilds)
            .set({ approved: true, approvedAt: nowSeconds() })
            .where(eq(guilds.id, target))
            .run();
          console.log(`✅ Guild ${target} approved by ${interaction.user.username}`);
        } else {
          await db.delete(guilds).where(eq(guilds.id, target)).run();
          teardownGuild(target);
          const guild = discord.guilds.cache.get(target);
          if (guild) {
            try { await guild.leave(); } catch (e) { console.error(`Failed to leave guild ${target}:`, e); }
          }
          console.log(`❌ Guild ${target} rejected by ${interaction.user.username}`);
        }

        await interaction.update(await adminView());
        await interaction.followUp({
          content: decoded.action === "a_approve" ? `✅ Approved **${target}**.` : `❌ Rejected **${target}**.`,
          ephemeral: true,
        });
        return;
      }

      // Queue panel selects. The page rides in the customId so the re-render
      // lands on the page the user was looking at.
      if (decoded?.action === "q_vote" || decoded?.action === "q_remove") {
        const guild = decoded.args[1];
        const page = Number(decoded.args[0]);
        const songId = Number(interaction.values[0]);
        if (!guild || !Number.isFinite(songId)) return;
        const roomId = guildRoomMap.get(guild) || guild;
        const song = await db.select().from(songs).where(eq(songs.id, songId)).get();
        const before = await loadQueue(roomId);

        if (!song) {
          await interaction.update(queuePanel(before, page, guild, interaction.user.id));
          await interaction.followUp({ content: "⚠️ That song is no longer in the queue.", ephemeral: true });
          return;
        }

        if (decoded.action === "q_vote") {
          const existing = await db
            .select()
            .from(votes)
            .where(and(eq(votes.songId, songId), eq(votes.userId, interaction.user.id)))
            .get();
          if (existing) {
            await interaction.update(queuePanel(before, page, guild, interaction.user.id));
            await interaction.followUp({ content: `🗳️ You already upvoted **${song.title || song.videoId}**.`, ephemeral: true });
            return;
          }
          await db.insert(votes).values({ songId, userId: interaction.user.id }).run();
          await db.update(songs).set({ votes: (song.votes ?? 0) + 1 }).where(eq(songs.id, songId)).run();
          await interaction.update(queuePanel(await loadQueue(roomId), page, guild, interaction.user.id));
          await interaction.followUp({ content: `👍 Upvoted **${song.title || song.videoId}**.`, ephemeral: true });
          return;
        }

        // Same gate as DELETE /api/rooms/:id/songs/:songId: the song's adder or
        // a global admin (ADMIN_DISCORD_IDS holds raw Discord user ids).
        const isOwner = !!song.addedByUserId && song.addedByUserId === interaction.user.id;
        if (!isOwner && !ADMIN_DISCORD_IDS.has(interaction.user.id)) {
          await interaction.update(queuePanel(before, page, guild, interaction.user.id));
          await interaction.followUp({ content: "🚫 You can only remove songs you added.", ephemeral: true });
          return;
        }
        await db.transaction(async (tx) => {
          await tx.delete(votes).where(eq(votes.songId, songId));
          await tx.delete(skipVotes).where(eq(skipVotes.songId, songId));
          await tx.delete(songs).where(eq(songs.id, songId));
        });
        await interaction.update(queuePanel(await loadQueue(roomId), page, guild, interaction.user.id));
        await interaction.followUp({ content: `🗑️ Removed **${song.title || song.videoId}**.`, ephemeral: true });
        return;
      }
      return;
    }

    if (interaction.isButton()) {
      const decoded = decodeId(interaction.customId);
      if (!decoded) return;

      // Now-playing card buttons. They mirror the two HTTP skip routes rather
      // than inventing a moderator bypass: vote-skip casts this user's vote and
      // stops the track once the threshold is reached.
      if (decoded.action === "p_skipvote" || decoded.action === "p_skip") {
        const guild = decoded.args[0];
        if (!guild) return;
        const roomId = guildRoomMap.get(guild) || guild;
        const current = await currentSongForRoom(roomId, guild);
        if (!current) {
          await interaction.reply({ content: "📭 Nothing is playing", ephemeral: true });
          return;
        }

        const threshold = skipThreshold(roomPresence(roomId));
        const isOwner = !!current.addedByUserId && current.addedByUserId === interaction.user.id;
        const votes = await skipVoteCount(current.id);
        const title = current.title || current.videoId;

        if (isOwner) {
          await markSkipped(guild, current.id);
          await interaction.reply({ content: `⏭️ Skipped **${title}** — you added it.`, ephemeral: true });
          return;
        }

        if (decoded.action === "p_skip") {
          if (votes < threshold) {
            await interaction.reply({
              content: `🗳️ Not enough votes to skip **${title}** — ${votes}/${threshold}. The person who added it can skip anytime.`,
              ephemeral: true,
            });
            return;
          }
          await markSkipped(guild, current.id);
          await interaction.reply({ content: `⏭️ Skipped **${title}** — ${votes}/${threshold} votes.`, ephemeral: true });
          return;
        }

        const existing = await db
          .select()
          .from(skipVotes)
          .where(and(eq(skipVotes.songId, current.id), eq(skipVotes.userId, interaction.user.id)))
          .get();
        if (existing) {
          await interaction.reply({ content: `🗳️ You already voted to skip **${title}** — ${votes}/${threshold}.`, ephemeral: true });
          return;
        }

        await db.insert(skipVotes).values({ songId: current.id, userId: interaction.user.id }).run();
        if (votes + 1 >= threshold) {
          await markSkipped(guild, current.id);
          await interaction.reply({ content: `⏭️ Skipped **${title}** — ${votes + 1}/${threshold} votes.`, ephemeral: true });
          return;
        }
        await interaction.reply({ content: `🗳️ Vote to skip **${title}** registered — ${votes + 1}/${threshold}.`, ephemeral: true });
        return;
      }

      if (!["q_prev", "q_refresh", "q_next"].includes(decoded.action)) return;
      const guild = decoded.args[1];
      const requested = Number(decoded.args[0]);
      if (!guild) return;
      const roomId = guildRoomMap.get(guild) || guild;
      const queue = await loadQueue(roomId);
      // Clamp against the queue as it is now, not as it was when the panel was
      // rendered — songs get voted, removed, or played out while it sits idle.
      const target =
        decoded.action === "q_prev" ? requested - 1 : decoded.action === "q_next" ? requested + 1 : requested;
      await interaction.update(
        queuePanel(queue, clampPage(target, queue.length), guild, interaction.user.id)
      );
      return;
    }

    if (interaction.commandName === "play") {
      const url = interaction.options.getString("url");
      if (!url || !guildId) {
        await interaction.reply("Provide a YouTube, SoundCloud, Mixcloud, Twitch, or streaming URL and be in a server");
        return;
      }
      const source = detectSource(url);
      if (!source) {
        await interaction.reply("Invalid YouTube, SoundCloud, Mixcloud, Twitch, or streaming URL");
        return;
      }

      await queueTrackForGuild(interaction, guildId, url, source);
    }

    if (interaction.commandName === "search") {
      if (!guildId) return;
      const query = interaction.options.getString("query");
      const source = (interaction.options.getString("source") ?? "youtube") as SearchableSource;

      // yt-dlp takes seconds, so acknowledge first and edit with the results.
      await interaction.deferReply({ ephemeral: true });
      if (!query) {
        await interaction.editReply("Provide something to search for.");
        return;
      }

      const options = toSelectOptions(await searchTracks(query, source, 10));
      if (options.length === 0) {
        await interaction.editReply(`🔍 No results for **${query}**.`);
        return;
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId(encodeId("search_pick"))
        .setPlaceholder(`Pick a ${source} result`)
        .addOptions(options);
      await interaction.editReply({
        content: `🔍 Results for **${query}** — pick one to queue:`,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      });
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
      // Disconnecting the bot affects everyone in the channel — gate to
      // server moderators rather than any member.
      if (!(interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ?? false)) {
        await interaction.reply({ content: "🚫 You need **Manage Server** permission to stop the bot.", ephemeral: true });
        return;
      }
      teardownGuild(guildId);
      await interaction.reply("⏹️ Stopped");
    }

    if (interaction.commandName === "skip") {
      if (!guildId) return;
      const roomId = guildRoomMap.get(guildId) || guildId;

      // Mirror the web skip gate (POST /api/rooms/:id/skip): the adder can
      // always skip, otherwise the song needs skipThreshold skip-votes from the
      // room's present listeners. Without this /skip was a one-click bypass of
      // the vote system the web enforces.
      const current = await currentSongForRoom(roomId, guildId);
      if (!current) {
        await interaction.reply({ content: "📭 Nothing is playing", ephemeral: true });
        return;
      }

      const threshold = skipThreshold(roomPresence(roomId));
      const isOwner = !!current.addedByUserId && current.addedByUserId === interaction.user.id;
      const skipVotesCount = await skipVoteCount(current.id);
      if (!isOwner && skipVotesCount < threshold) {
        await interaction.reply({
          content: `🗳️ Not enough votes to skip **${current.title || current.videoId}** — ${skipVotesCount}/${threshold}. The person who added it can skip anytime.`,
          ephemeral: true,
        });
        return;
      }

      await markSkipped(guildId, current.id);
      await interaction.reply("⏭️ Skipped");
    }

    if (interaction.commandName === "queue") {
      if (!guildId) return;
      const roomId = guildRoomMap.get(guildId) || guildId;
      const queue = await loadQueue(roomId);
      // Public, not ephemeral: this panel is the shared queue everyone in the
      // channel votes and removes from.
      await interaction.reply(queuePanel(queue, 1, guildId, interaction.user.id));
    }

    if (interaction.commandName === "lyrics") {
      if (!guildId) return;
      const roomId = guildRoomMap.get(guildId) || guildId;
      const current = await currentSongForRoom(roomId, guildId);
      if (!current) {
        await interaction.reply({ content: "📭 Nothing is playing", ephemeral: true });
        return;
      }
      const found = await fetchLyrics(current.title || current.videoId, current.uploader);
      const text = found ? formatLyrics(found) : null;
      if (!text) {
        await interaction.reply({
          content: `❌ No lyrics found for **${current.title || current.videoId}**.`,
          ephemeral: true,
        });
        return;
      }
      await interaction.reply({ content: text, ephemeral: true });
    }

    if (interaction.commandName === "reset") {
      if (!guildId) return;
      // Resetting the whole queue is a room-wide action — gate to moderators.
      if (!(interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild) ?? false)) {
        await interaction.reply({ content: "🚫 You need **Manage Server** permission to reset the queue.", ephemeral: true });
        return;
      }
      const roomId = guildRoomMap.get(guildId) || guildId;

      await db.update(songs).set({ played: false }).where(eq(songs.roomId, roomId)).run();
      await interaction.reply("🔄 Queue reset — all songs are now playable");
    }

    // Report which room this guild's playback is fed from (the guildRoomMap
    // entry), so people in the server can see and join the same room in the
    // browser. Falls back to the guild's own id when nothing has been bound
    // yet — but only after /play or /listen sets the map, so a missing entry
    // means the bot has never been started here.
    if (interaction.commandName === "room") {
      if (!guildId) return;
      const roomId = guildRoomMap.get(guildId);
      if (!roomId) {
        await interaction.reply("📭 No room bound to this server yet. Use `/play` or `/listen` to start.");
        return;
      }

      const room = await db.select().from(rooms).where(eq(rooms.id, roomId)).get();
      const connected = connections.has(guildId);
      const isDefault = roomId === guildId;

      const counts = await db
        .select({
          total: sql<number>`count(*)`,
          pending: sql<number>`sum(case when coalesce(${songs.played}, 0) = 0 then 1 else 0 end)`,
        })
        .from(songs)
        .where(eq(songs.roomId, roomId))
        .get();
      const total = Number(counts?.total ?? 0);
      const pending = Number(counts?.pending ?? 0);

      let ownerLine: string | null = null;
      if (room?.createdBy) {
        const owner = await db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, room.createdBy))
          .get();
        if (owner?.username) ownerLine = `• Owner: ${owner.username}`;
      }

      let nowLine: string | null = null;
      const track = currentTracks.get(guildId);
      if (track) {
        const cur = await db
          .select({ title: songs.title, videoId: songs.videoId })
          .from(songs)
          .where(eq(songs.id, track.songId))
          .get();
        nowLine = `• Now playing: **${cur?.title || cur?.videoId || `#${track.songId}`}**`;
      }

      const header = isDefault
        ? "🎵 This server is playing from its **default queue**"
        : `🎵 This server is playing from room **${roomId}**`;
      const lines = [
        header,
        `• Room ID: \`${roomId}\``,
        ownerLine,
        `• Bot: ${connected ? "🔊 Connected" : "💤 Not connected"}`,
        nowLine,
        `• Songs: ${pending} pending / ${total} total`,
      ].filter(Boolean);

      await interaction.reply(lines.join("\n"));
    }

    if (interaction.commandName === "admin") {
      if (!ADMIN_DISCORD_IDS.has(interaction.user.id)) {
        await interaction.reply({ content: "🚫 Not authorized.", ephemeral: true });
        return;
      }
      await interaction.reply({ ...(await adminView()), ephemeral: true });
    }

    if (interaction.commandName === "help") {
      // Built from the registered set, so it can never drift from /commands.
      const lines = commands.map((c) => `• \`/${c.name}\` — ${c.description}`);
      await interaction.reply({ content: `**Commands**\n${lines.join("\n")}`, ephemeral: true });
    }
  } catch (err) {
    const label = interaction.isChatInputCommand() ? `'${interaction.commandName}'` : `component '${interaction.customId}'`;
    console.error(`Interaction ${label} failed:`, err);
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
    await tx.delete(skipVotes).where(inArray(skipVotes.songId, ids));
    await tx.delete(songs).where(inArray(songs.id, ids));
  });
  console.log(`🧹 GC: purged ${ids.length} old played song(s)`);
}

async function runMaintenance() {
  try { await gcEmptyRooms(); } catch (e) { console.error("gcEmptyRooms failed:", e); }
  try { await purgePlayedSongs(); } catch (e) { console.error("purgePlayedSongs failed:", e); }
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

// Discord listeners in the bot's voice channel don't register web presence
// (userCurrentRoom is only populated via the browser), so without this the
// skip threshold would ignore them and a minority web vote could skip a song
// many people are listening to in voice. Counts non-bot members in the bot's
// channel across every guild bound to the room.
function voicePresenceByRoom(): Map<string, number> {
  const map = new Map<string, number>();
  const botId = discord.user?.id;
  for (const [guildId, roomId] of guildRoomMap) {
    const conn = connections.get(guildId);
    if (!conn) continue;
    const channelId = conn.joinConfig.channelId;
    if (!channelId) continue;
    const guild = discord.guilds.cache.get(guildId);
    if (!guild) continue;
    for (const vs of guild.voiceStates.cache.values()) {
      if (vs.channelId === channelId && vs.id !== botId) {
        map.set(roomId, (map.get(roomId) ?? 0) + 1);
      }
    }
  }
  return map;
}

// Total listeners in a room: web presence + Discord voice presence.
function roomPresence(roomId: string): number {
  const web = [...userCurrentRoom.values()].filter((r) => r === roomId).length;
  const voice = voicePresenceByRoom().get(roomId) ?? 0;
  return web + voice;
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
