import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import Navbar from "../components/Navbar";
import SongItem from "../components/SongItem";
import Waveform from "../components/Waveform";
import Glyph from "../components/Glyph";
import ReticleCorners from "../components/ReticleCorners";
import LyricsPanel from "../components/LyricsPanel";
import { useAuth } from "../hooks/useAuth";

type Source = "youtube" | "soundcloud";

interface Song {
  id: number;
  videoId: string;
  source: Source;
  url: string;
  title: string | null;
  uploader: string | null;
  thumbnail: string | null;
  addedBy: string | null;
  addedByUserId: string | null;
  votes: number;
  played: boolean;
  playlistId: string | null;
  playlistTitle: string | null;
}

interface SearchResult {
  source: Source;
  videoId: string;
  title: string;
  duration: number | null;
  uploader: string | null;
  url: string;
  thumbnail: string | null;
}

function fmtDuration(seconds: number | null): string {
  if (!seconds) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// YouTube thumbnails are derived from the videoId (no DB column needed);
// SoundCloud has no predictable CDN pattern so its artwork is stored verbatim.
function thumbUrl(s: { source: Source; videoId: string; thumbnail: string | null }, size = "hqdefault"): string | null {
  if (s.thumbnail) return s.thumbnail;
  return s.source === "youtube" ? `https://i.ytimg.com/vi/${s.videoId}/${size}.jpg` : null;
}

export default function Room() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [songs, setSongs] = useState<Song[]>([]);
  const [userVotes, setUserVotes] = useState<number[]>([]);
  const [presentCount, setPresentCount] = useState(1);
  const [newUrl, setNewUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewSong, setPreviewSong] = useState<Song | null>(null);
  const [canDeleteRoom, setCanDeleteRoom] = useState(false);
  const [confirmDeleteRoom, setConfirmDeleteRoom] = useState(false);
  const [connectStatus, setConnectStatus] = useState<"idle" | "loading" | "ok" | "err">("idle");
  const [inputMode, setInputMode] = useState<"url" | "search">("url");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchSource, setSearchSource] = useState<Source>("youtube");
  const [collapsedPlaylists, setCollapsedPlaylists] = useState<Set<string>>(new Set());
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sending, setSending] = useState(false);

  // When the currently-playing track started (server clock), for lyric sync.
  const [currentSongStartedAt, setCurrentSongStartedAt] = useState<number | null>(null);

  // Signatures of the last applied payload, so an unchanged 4s poll doesn't
  // rebuild a new array and re-render the whole queue.
  const songsSigRef = useRef("");
  const votesSigRef = useRef("");
  const fetchSongs = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/rooms/${id}/songs`, { credentials: "include" });
      const data = await res.json();
      const incoming: Song[] = data.songs || [];
      const sig = incoming.map((s) => `${s.id}:${s.votes}:${s.played ? 1 : 0}:${s.title ?? ""}`).join("|");
      if (sig !== songsSigRef.current) {
        songsSigRef.current = sig;
        setSongs(incoming);
      }
      const incomingVotes: number[] = data.userVotes || [];
      const votesSig = incomingVotes.join(",");
      if (votesSig !== votesSigRef.current) {
        votesSigRef.current = votesSig;
        setUserVotes(incomingVotes);
      }
      // Primitive setState with an unchanged value is a no-op re-render in React.
      setPresentCount(data.presentCount ?? 1);
      setCurrentSongStartedAt(data.currentSongStartedAt ?? null);
    } catch {
      setError("ERR_01: fetch_failed;");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchSongs();
    const interval = setInterval(fetchSongs, 4000);
    return () => clearInterval(interval);
  }, [fetchSongs]);

  useEffect(() => {
    if (!id || !user) return;
    let active = true;

    const announce = (roomId: string | null) =>
      fetch("/api/user/room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ roomId }),
        keepalive: true,
      });

    announce(id)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => active && data && setCanDeleteRoom(!!data.canDelete))
      .catch(() => {});

    const handlePageHide = () => { announce(null).catch(() => {}); };
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      active = false;
      window.removeEventListener("pagehide", handlePageHide);
      announce(null).catch(() => {});
    };
  }, [id, user]);

  // The first unplayed song is "now playing". Memoized so it isn't recomputed on
  // every unrelated re-render (lyrics live in their own component now).
  const currentSong = useMemo(() => songs.find((s) => !s.played), [songs]);

  const leaveRoom = () => navigate("/");

  const deleteRoom = async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/rooms/${id}`, { method: "DELETE", credentials: "include" });
      if (res.ok) {
        navigate("/");
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "ERR_05: delete_room_failed;");
        setTimeout(() => setError(null), 3000);
        setConfirmDeleteRoom(false);
      }
    } catch {
      setError("ERR_05: delete_room_failed;");
      setTimeout(() => setError(null), 3000);
    }
  };

  const addSong = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl.trim() || !id || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/rooms/${id}/songs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url: newUrl }),
      });
      if (res.ok) {
        setNewUrl("");
        await fetchSongs();
      } else {
        const data = await res.json();
        setError(data.error || "ERR_02: add_failed;");
        setTimeout(() => setError(null), 3000);
      }
    } catch {
      setError("ERR_02: add_failed;");
      setTimeout(() => setError(null), 3000);
    } finally {
      setSending(false);
    }
  };

  // Stable identities so memoized SongItems don't re-render when Room re-renders.
  const vote = useCallback(async (songId: number) => {
    if (!id || !user) return;
    try {
      const res = await fetch(`/api/rooms/${id}/songs/${songId}/vote`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        await fetchSongs();
      } else {
        const data = await res.json();
        setError(data.error || "ERR_03: vote_failed;");
        setTimeout(() => setError(null), 3000);
      }
    } catch {
      setError("ERR_03: vote_failed;");
      setTimeout(() => setError(null), 3000);
    }
  }, [id, user, fetchSongs]);

  const deleteSong = useCallback(async (songId: number) => {
    if (!id) return;
    try {
      const res = await fetch(`/api/rooms/${id}/songs/${songId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) await fetchSongs();
    } catch {
      setError("ERR_04: delete_failed;");
      setTimeout(() => setError(null), 3000);
    }
  }, [id, fetchSongs]);

  useEffect(() => {
    if (inputMode !== "search" || !searchQuery.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&source=${searchSource}`);
        const data = await res.json();
        setSearchResults(data.results || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 500);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchQuery, inputMode, searchSource]);

  const addFromSearch = async (result: SearchResult) => {
    if (!id) return;
    try {
      const res = await fetch(`/api/rooms/${id}/songs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ url: result.url }),
      });
      if (res.ok) {
        setSearchQuery("");
        setSearchResults([]);
        await fetchSongs();
      } else {
        const data = await res.json();
        setError(data.error || "ERR_02: add_failed;");
        setTimeout(() => setError(null), 3000);
      }
    } catch {
      setError("ERR_02: add_failed;");
      setTimeout(() => setError(null), 3000);
    }
  };

  const copyInvite = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const connectBot = async () => {
    if (!id || connectStatus === "loading") return;
    setConnectStatus("loading");
    try {
      const res = await fetch(`/api/rooms/${id}/connect`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        setConnectStatus("ok");
        setTimeout(() => setConnectStatus("idle"), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "ERR_06: connect_failed;");
        setTimeout(() => setError(null), 3000);
        setConnectStatus("err");
        setTimeout(() => setConnectStatus("idle"), 3000);
      }
    } catch {
      setError("ERR_06: connect_failed;");
      setTimeout(() => setError(null), 3000);
      setConnectStatus("err");
      setTimeout(() => setConnectStatus("idle"), 3000);
    }
  };

  const skipPlaylist = async (playlistId: string) => {
    if (!id) return;
    try {
      const res = await fetch(`/api/rooms/${id}/playlists/${playlistId}/skip`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        await fetchSongs();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "ERR_08: skip_playlist_failed;");
        setTimeout(() => setError(null), 3000);
      }
    } catch {
      setError("ERR_08: skip_playlist_failed;");
      setTimeout(() => setError(null), 3000);
    }
  };

  const skipSong = async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/rooms/${id}/skip`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        await fetchSongs();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "ERR_07: skip_failed;");
        setTimeout(() => setError(null), 3000);
      }
    } catch {
      setError("ERR_07: skip_failed;");
      setTimeout(() => setError(null), 3000);
    }
  };

  const pendingSongs = useMemo(() => songs.filter((s) => !s.played).slice(1), [songs]);
  const playedSongs = useMemo(() => songs.filter((s) => s.played), [songs]);
  const skipThreshold = Math.max(1, Math.ceil(presentCount / 2));
  const canSkip = !!currentSong && (
    currentSong.votes >= skipThreshold || user?.id === currentSong.addedByUserId
  );

  // Group pending songs: consecutive songs sharing a playlistId are merged into
  // one entry; individual songs are their own entry.
  type QueueGroup =
    | { type: "song"; song: Song }
    | { type: "playlist"; playlistId: string; playlistTitle: string; songs: Song[] };

  const pendingGroups = useMemo<QueueGroup[]>(() => pendingSongs.reduce<QueueGroup[]>((acc, song) => {
    if (song.playlistId) {
      const last = acc[acc.length - 1];
      if (last?.type === "playlist" && last.playlistId === song.playlistId) {
        last.songs.push(song);
      } else {
        acc.push({ type: "playlist", playlistId: song.playlistId, playlistTitle: song.playlistTitle ?? "Playlist", songs: [song] });
      }
    } else {
      acc.push({ type: "song", song });
    }
    return acc;
  }, []), [pendingSongs]);

  return (
    <div className="min-h-screen flex flex-col bg-ps-ink-900">
      <Navbar />

      <main className="flex-1 flex flex-col lg:pl-80">

        {/* ── Left: Now playing + room controls — sticky sidebar ── */}
        <div className="w-full shrink-0 flex flex-col border-b border-white/10 bg-ps-graphite-700/30 lg:fixed lg:top-[57px] lg:left-0 lg:w-80 lg:h-[calc(100vh-57px)] lg:border-b-0 lg:border-r lg:overflow-y-auto lg:z-10">

          {/* Room identity */}
          <div className="p-5 border-b border-white/10">
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-8 h-8 flex items-center justify-center border border-white/10 bg-ps-graphite-700 text-ps-iris-rose shrink-0"
                style={{ boxShadow: "var(--ps-shadow-etch)" }}
              >
                <Glyph name="heart" className="w-3.5 h-3.5" />
              </div>
              <div className="min-w-0">
                <p className="text-[9px] font-mono text-ps-steel-400 tracking-[0.14em] uppercase">_room;</p>
                <p className="text-xs font-mono font-bold text-ps-iris-cyan tracking-wider truncate">{id}</p>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-1.5">
              {user && (
                <button
                  onClick={connectBot}
                  disabled={connectStatus === "loading"}
                  className="flex items-center gap-1.5 px-3 py-1.5 border text-[10px] font-mono tracking-wide transition-all duration-120 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{
                    transitionTimingFunction: "var(--ps-ease-print)",
                    ...(connectStatus === "ok"
                      ? { borderColor: "rgb(var(--ps-signal-ok) / 0.4)", background: "rgb(var(--ps-signal-ok) / 0.08)", color: "var(--ps-signal-ok)" }
                      : connectStatus === "err"
                      ? { borderColor: "rgb(var(--ps-signal-danger) / 0.4)", background: "rgb(var(--ps-signal-danger) / 0.08)", color: "var(--ps-signal-danger)" }
                      : { borderColor: "rgb(255 255 255 / 0.1)", background: "var(--ps-graphite-700)", color: "var(--ps-iris-cyan)" }),
                  }}
                >
                  {connectStatus === "ok" ? (
                    <><Glyph name="check" className="w-3 h-3" />_connected;</>
                  ) : connectStatus === "err" ? (
                    <><Glyph name="target-x" className="w-3 h-3" />_not_in_voice;</>
                  ) : (
                    <><Glyph name="reticle" className="w-3 h-3" />SUMMON;</>
                  )}
                </button>
              )}

              <button
                onClick={copyInvite}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-ps-graphite-700 hover:bg-ps-graphite-600 border border-white/10 text-[10px] font-mono text-ps-fg-inv-2 tracking-wide transition-all duration-120"
                style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
              >
                {copied
                  ? <><Glyph name="check" className="w-3 h-3 text-ps-signal-ok" />_copied;</>
                  : <><Glyph name="reticle" className="w-3 h-3 text-ps-steel-400" />INVITE;</>
                }
              </button>

              <button
                onClick={leaveRoom}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-ps-graphite-700 hover:bg-ps-signal-danger/15 border border-white/10 hover:border-ps-signal-danger/40 text-[10px] font-mono text-ps-fg-inv-2 hover:text-ps-signal-danger tracking-wide transition-all duration-120"
                style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
              >
                <Glyph name="log-out" className="w-3 h-3" />
                LEAVE;
              </button>

              {canDeleteRoom && (
                confirmDeleteRoom ? (
                  <>
                    <button
                      onClick={deleteRoom}
                      className="px-3 py-1.5 bg-ps-signal-danger hover:opacity-90 border border-ps-signal-danger text-[10px] font-mono font-bold text-ps-ink-900 tracking-wide transition-all duration-120"
                    >
                      CONFIRM;
                    </button>
                    <button
                      onClick={() => setConfirmDeleteRoom(false)}
                      className="px-3 py-1.5 bg-ps-graphite-700 hover:bg-ps-graphite-600 border border-white/10 text-[10px] font-mono text-ps-fg-inv-2 tracking-wide transition-all duration-120"
                    >
                      NO;
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteRoom(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-ps-graphite-700 hover:bg-ps-signal-danger/15 border border-white/10 hover:border-ps-signal-danger/40 text-[10px] font-mono text-ps-steel-400 hover:text-ps-signal-danger tracking-wide transition-all duration-120"
                    style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
                  >
                    <Glyph name="target-x" className="w-3 h-3" />
                    DELETE;
                  </button>
                )
              )}
            </div>
          </div>

          {/* Now playing */}
          <div className="flex-1 flex flex-col">
            {currentSong ? (
              <>
                {previewSong ? (
                  <div className="p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-mono text-ps-iris-cyan tracking-[0.14em] uppercase">_preview;</span>
                      <button
                        onClick={() => setPreviewSong(null)}
                        className="flex items-center gap-1 text-[9px] font-mono text-ps-steel-400 hover:text-ps-fg-inv-1 transition-colors"
                      >
                        <Glyph name="target-x" className="w-3 h-3" />close;
                      </button>
                    </div>
                    <div
                      className="relative aspect-video w-full border border-white/10 text-ps-iris-cyan/50 overflow-hidden"
                      style={{ boxShadow: "var(--ps-shadow-float)" }}
                    >
                      {thumbUrl(previewSong) ? (
                        <img src={thumbUrl(previewSong)!} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-ps-graphite-700">
                          <Glyph name="diamond" className="w-8 h-8 text-ps-steel-400" />
                        </div>
                      )}
                      <ReticleCorners size={12} />
                    </div>
                    <p className="text-[10px] font-mono text-ps-steel-400 tracking-wide text-center">
                      {previewSong.title || previewSong.videoId}
                    </p>
                    <a
                      href={previewSong.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-1.5 text-[9px] font-mono text-ps-steel-400 hover:text-ps-iris-cyan transition-colors"
                    >
                      <Glyph name="reticle" className="w-3 h-3" />
                      {previewSong.source === "youtube" ? "_open_in_youtube;" : "_open_in_soundcloud;"}
                    </a>
                  </div>
                ) : (
                  <>
                    {/* Thumbnail with waveform overlay */}
                    <div className="relative aspect-video w-full overflow-hidden border-b border-white/10">
                      {thumbUrl(currentSong, "hqdefault") ? (
                        <img
                          src={thumbUrl(currentSong, "hqdefault")!}
                          alt=""
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            if (currentSong.source === "youtube") {
                              e.currentTarget.src = `https://i.ytimg.com/vi/${currentSong.videoId}/mqdefault.jpg`;
                            }
                          }}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-ps-graphite-700">
                          <Glyph name="diamond" className="w-10 h-10 text-ps-steel-400" />
                        </div>
                      )}
                      {/* gradient so ON_AIR badge and waveform are legible */}
                      <div className="absolute inset-0 bg-gradient-to-t from-ps-ink-900/90 via-ps-ink-900/10 to-transparent" />
                      <div className="absolute top-3 left-3 flex items-center gap-2">
                        <div className="w-2 h-2 bg-ps-signal-danger rounded-full" style={{ animation: "ps-pulse 1.5s ease-in-out infinite" }} />
                        <span className="text-[9px] font-mono font-bold text-ps-signal-danger tracking-[0.14em] uppercase">ON_AIR;</span>
                      </div>
                      <div className="absolute bottom-3 inset-x-3">
                        <Waveform isPlaying={true} />
                      </div>
                    </div>

                    {/* Song info */}
                    <div className="p-5 space-y-1.5">
                      <p className="font-display font-semibold text-sm text-ps-fg-inv-1 leading-snug">
                        {currentSong.title || currentSong.videoId}
                      </p>
                      <p className="text-[10px] font-mono text-ps-steel-400 tracking-wide">
                        _added_by:{currentSong.addedBy}
                      </p>
                      <button
                        onClick={() => setPreviewSong(currentSong)}
                        className="flex items-center gap-1.5 text-[9px] font-mono text-ps-steel-400 hover:text-ps-iris-cyan transition-colors pt-1"
                      >
                        <Glyph name="reticle" className="w-3 h-3" />
                        _preview;
                      </button>
                    </div>

                    {/* Lyrics — owns its own state + 250ms sync tick so it
                        never re-renders the queue. */}
                    <LyricsPanel
                      songId={currentSong.id}
                      title={currentSong.title}
                      uploader={currentSong.uploader}
                      startedAt={currentSongStartedAt}
                    />

                  </>
                )}
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center space-y-5 py-8">
                <div className="relative inline-flex items-center justify-center">
                  <div
                    className="w-20 h-20 border border-white/10 bg-ps-graphite-700 flex items-center justify-center text-ps-steel-400"
                    style={{ boxShadow: "var(--ps-shadow-card)" }}
                  >
                    <Glyph name="register-cross" className="w-9 h-9" />
                    <ReticleCorners className="text-white/15" />
                  </div>
                  <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-ps-graphite-600 border border-white/10 flex items-center justify-center text-ps-fg-inv-1">
                    <Glyph name="plus" className="w-2.5 h-2.5" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <p className="text-sm font-display font-bold text-ps-fg-inv-1 tracking-tight">_empty_room;</p>
                  <p className="text-[10px] font-mono text-ps-steel-400 tracking-wide">// add_song_to_start;</p>
                </div>
              </div>
            )}
          </div>

          {/* Barcode footer */}
          <div className="border-t border-white/10 p-4 flex justify-center text-ps-steel-400 opacity-20">
            <Glyph name="barcode" className="h-3 w-auto" />
          </div>
        </div>

        {/* ── Right: Queue management ── */}
        <div className="flex-1 flex flex-col min-h-0 lg:min-h-[calc(100vh-57px)]">

          {/* Add song — URL or search mode */}
          <div className="border-b border-white/10 shrink-0">
            {/* Mode tabs */}
            <div className="flex border-b border-white/10">
              {(["url", "search"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => { setInputMode(m); setSearchQuery(""); setSearchResults([]); setNewUrl(""); }}
                  className={`px-5 py-2.5 text-[10px] font-mono font-bold tracking-[0.14em] uppercase transition-colors duration-120 border-r border-white/10 last:border-r-0 ${
                    inputMode === m
                      ? "text-ps-fg-inv-1 bg-ps-graphite-700/60"
                      : "text-ps-steel-400 hover:text-ps-fg-inv-2 bg-transparent"
                  }`}
                >
                  _{m};
                </button>
              ))}
            </div>

            <div className="p-4">
              {inputMode === "url" ? (
                <form onSubmit={addSong} className="flex gap-2">
                  <input
                    type="text"
                    value={newUrl}
                    onChange={(e) => setNewUrl(e.target.value)}
                    placeholder="_youtube_or_soundcloud_url;"
                    className="flex-1 px-4 py-3 bg-ps-graphite-700 border border-white/10 text-ps-fg-inv-1 placeholder-ps-steel-400 font-mono text-sm tracking-wide focus:outline-none focus:border-ps-iris-rose/40 transition-all duration-120"
                    style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
                  />
                  <button
                    type="submit"
                    disabled={!newUrl.trim() || sending}
                    className="group relative px-6 py-3 bg-ps-white text-ps-ink-900 disabled:opacity-30 disabled:cursor-not-allowed font-mono text-xs font-bold tracking-[0.14em] uppercase transition-all duration-120 hover:bg-ps-pearl-100 shrink-0"
                    style={{ boxShadow: "var(--ps-shadow-card)", transitionTimingFunction: "var(--ps-ease-print)" }}
                  >
                    ADD;
                    <div className="absolute bottom-0 left-0 right-0 h-[2px] ps-shimmer-bar opacity-0 group-hover:opacity-100 transition-opacity duration-120" />
                  </button>
                </form>
              ) : (
                <div className="space-y-2">
                  <div className="flex border border-white/10 w-fit">
                    {(["youtube", "soundcloud"] as const).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSearchSource(s)}
                        className={`px-3 py-1.5 text-[9px] font-mono font-bold tracking-[0.12em] uppercase transition-colors duration-120 border-r border-white/10 last:border-r-0 ${
                          searchSource === s
                            ? "text-ps-fg-inv-1 bg-ps-graphite-700"
                            : "text-ps-steel-400 hover:text-ps-fg-inv-2 bg-transparent"
                        }`}
                      >
                        {s === "youtube" ? "YT" : "SC"}
                      </button>
                    ))}
                  </div>
                  <div className="relative flex gap-2 items-center">
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={searchSource === "youtube" ? "_search_youtube;" : "_search_soundcloud;"}
                      autoFocus
                      className="flex-1 px-4 py-3 bg-ps-graphite-700 border border-white/10 text-ps-fg-inv-1 placeholder-ps-steel-400 font-mono text-sm tracking-wide focus:outline-none focus:border-ps-iris-cyan/40 transition-all duration-120"
                      style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
                    />
                    {searching && (
                      <div className="absolute right-4 w-3 h-3 border border-ps-iris-cyan/40 border-t-ps-iris-cyan rounded-full animate-spin" />
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Queue header */}
          <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between shrink-0">
            <span className="text-[10px] font-mono font-bold text-ps-steel-400 tracking-[0.14em] uppercase">_queue;</span>
            <span className="text-[10px] font-mono text-ps-steel-400">
              {pendingSongs.length + (currentSong ? 1 : 0)}
            </span>
          </div>

          {/* Scrollable list — search results or queue */}
          <div className="flex-1 overflow-y-auto">
            {inputMode === "search" && (searchResults.length > 0 || searchQuery.trim()) ? (
              <div className="p-4 space-y-1.5">
                {searchResults.length === 0 && !searching ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-3">
                    <Glyph name="no-symbol" className="w-7 h-7 text-ps-steel-400" />
                    <p className="text-[10px] font-mono text-ps-steel-400 tracking-wide">// no_results;</p>
                  </div>
                ) : (
                  searchResults.map((result) => (
                    <div
                      key={result.videoId}
                      className="group flex items-center gap-3 p-3 bg-ps-graphite-700 hover:bg-ps-graphite-600 border border-white/10 transition-all duration-120"
                      style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
                    >
                      {result.thumbnail ? (
                        <img
                          src={result.thumbnail}
                          alt=""
                          className="w-14 h-[39px] object-cover shrink-0 border border-white/10"
                        />
                      ) : (
                        <div className="w-14 h-[39px] flex items-center justify-center shrink-0 border border-white/10 bg-ps-ink-800 text-ps-steel-400">
                          <Glyph name="diamond" className="w-3 h-3" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-ps-fg-inv-1 truncate leading-snug">{result.title}</p>
                        <p className="text-[10px] font-mono text-ps-steel-400 mt-0.5 tracking-wide">
                          {result.uploader && <span>{result.uploader}</span>}
                          {result.uploader && result.duration && <span className="mx-1.5 opacity-40">·</span>}
                          {result.duration && <span>{fmtDuration(result.duration)}</span>}
                        </p>
                      </div>
                      <button
                        onClick={() => addFromSearch(result)}
                        className="shrink-0 px-3 py-1.5 bg-ps-white text-ps-ink-900 font-mono text-[10px] font-bold tracking-[0.12em] uppercase hover:bg-ps-pearl-100 transition-colors duration-120"
                        style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
                      >
                        ADD;
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : loading ? (
              <div className="p-5 space-y-2">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-14 bg-ps-graphite-700/50 animate-pulse" />
                ))}
              </div>
            ) : songs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-8">
                <Glyph name="no-symbol" className="w-8 h-8 text-ps-steel-400" />
                <p className="text-[10px] font-mono text-ps-steel-400 tracking-wide">// no_songs_queued;</p>
              </div>
            ) : (
              <div className="p-5 space-y-2">
                {/* Now playing highlight */}
                {currentSong && (
                  <div className="relative p-4 pl-5 bg-ps-graphite-700 border border-white/10">
                    <span className="absolute inset-y-0 left-0 w-0.5 bg-ps-iris-cyan" />
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-1.5 h-1.5 bg-ps-iris-cyan rounded-full"
                          style={{ animation: "ps-pulse 1.5s ease-in-out infinite" }}
                        />
                        <span className="text-[9px] font-mono font-bold text-ps-iris-cyan tracking-[0.14em] uppercase">_playing;</span>
                      </div>
                      {user && (
                        <button
                          onClick={skipSong}
                          disabled={!canSkip}
                          title={canSkip ? "_skip;" : `_need_${skipThreshold}_votes;`}
                          className={`flex items-center gap-1.5 px-2.5 py-1 border text-[9px] font-mono font-bold tracking-[0.12em] uppercase transition-all duration-120 ${
                            canSkip
                              ? "border-ps-steel-400/40 bg-ps-ink-800 text-ps-fg-inv-1 hover:border-ps-signal-danger/50 hover:text-ps-signal-danger cursor-pointer"
                              : "border-white/10 bg-transparent text-ps-steel-400/50 cursor-not-allowed"
                          }`}
                          style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
                        >
                          <Glyph name="chevron-up" className="w-3 h-3 rotate-90" />
                          {currentSong.votes}/{skipThreshold}
                        </button>
                      )}
                    </div>
                    <p className="text-sm font-medium text-ps-fg-inv-1 truncate">{currentSong.title || currentSong.videoId}</p>
                    <p className="text-[11px] font-mono text-ps-steel-400 mt-0.5">_by:{currentSong.addedBy}</p>
                  </div>
                )}

                {/* Pending */}
                {pendingGroups.map((group) =>
                  group.type === "song" ? (
                    <SongItem
                      key={group.song.id}
                      song={group.song}
                      isVoted={userVotes.includes(group.song.id)}
                      canDelete={user?.id === group.song.addedByUserId}
                      onVote={vote}
                      onDelete={deleteSong}
                      onPreview={setPreviewSong}
                    />
                  ) : (() => {
                    const isCollapsed = collapsedPlaylists.has(group.playlistId);
                    const toggleCollapse = () =>
                      setCollapsedPlaylists((prev) => {
                        const next = new Set(prev);
                        next.has(group.playlistId) ? next.delete(group.playlistId) : next.add(group.playlistId);
                        return next;
                      });
                    return (
                      <div key={group.playlistId} className="border border-white/10 bg-ps-graphite-700/40">
                        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10">
                          <button
                            onClick={toggleCollapse}
                            className="flex items-center gap-2 min-w-0 flex-1 text-left"
                          >
                            <Glyph
                              name="chevron-up"
                              className={`w-3 h-3 shrink-0 text-ps-iris-rose transition-transform duration-120 ${isCollapsed ? "-rotate-90" : "rotate-180"}`}
                              style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
                            />
                            <Glyph name="reticle" className="w-3 h-3 shrink-0 text-ps-iris-rose" />
                            <span className="text-[10px] font-mono font-bold text-ps-iris-rose tracking-[0.12em] uppercase truncate">
                              {group.playlistTitle}
                            </span>
                            <span className="text-[9px] font-mono text-ps-steel-400 shrink-0">
                              ×{group.songs.length}
                            </span>
                          </button>
                          {user && (user.id === group.songs[0]?.addedByUserId || user.isAdmin) && (
                            <button
                              onClick={() => skipPlaylist(group.playlistId)}
                              className="flex items-center gap-1 px-2 py-1 border border-white/10 bg-ps-ink-800 hover:border-ps-signal-danger/50 hover:text-ps-signal-danger text-[9px] font-mono text-ps-steel-400 tracking-[0.12em] uppercase transition-all duration-120 shrink-0"
                              style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
                            >
                              <Glyph name="chevron-up" className="w-3 h-3 rotate-90" />
                              skip_all;
                            </button>
                          )}
                        </div>
                        {!isCollapsed && (
                          <div className="divide-y divide-white/5">
                            {group.songs.map((song) => (
                              <SongItem
                                key={song.id}
                                song={song}
                                isVoted={userVotes.includes(song.id)}
                                canDelete={user?.id === song.addedByUserId}
                                onVote={vote}
                                onDelete={deleteSong}
                                onPreview={setPreviewSong}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()
                )}
              </div>
            )}
          </div>

          {/* Played — compact, pinned to bottom */}
          {playedSongs.length > 0 && (
            <div className="border-t border-white/10 shrink-0 max-h-40 overflow-y-auto">
              <div className="px-5 py-3 flex items-center gap-2">
                <span className="text-[9px] font-mono font-bold text-ps-steel-400 tracking-[0.14em] uppercase">_played;</span>
                <span className="text-[9px] font-mono text-ps-steel-400 opacity-60">{playedSongs.length}</span>
              </div>
              <div className="px-5 pb-3 space-y-1.5">
                {playedSongs.map((song) => (
                  <div key={song.id} className="flex items-center gap-2 opacity-50">
                    <Glyph name="check" className="w-3 h-3 shrink-0 text-ps-signal-ok" />
                    <p className="text-[11px] font-mono truncate text-ps-steel-400">{song.title || song.videoId}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Error toast */}
      {error && (
        <div
          className="fixed bottom-6 right-6 px-4 py-3 bg-ps-ink-800 border border-ps-signal-danger/30 text-ps-signal-danger text-xs font-mono tracking-wide shadow-lg z-50"
          style={{ boxShadow: "var(--ps-shadow-deep)" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
