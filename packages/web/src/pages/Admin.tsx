import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import Navbar from "../components/Navbar";
import Glyph from "../components/Glyph";
import { useAuth } from "../hooks/useAuth";

interface AdminRoom {
  id: string;
  createdBy: string | null;
  ownerName: string | null;
  songCount: number;
  pendingCount: number;
  presentCount: number;
  lastActivityAt: number | null;
  createdAt: number | null;
}

interface AdminGuild {
  id: string;
  name: string | null;
  approved: boolean;
  requestedBy: string | null;
  requestedByUsername: string | null;
  requestedAt: number | null;
  approvedAt: number | null;
}

function timeAgo(epochSeconds: number | null): string {
  if (!epochSeconds) return "—";
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return `${Math.max(diff, 0)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export default function Admin() {
  const { user, loading } = useAuth();
  const [rooms, setRooms] = useState<AdminRoom[]>([]);
  const [fetching, setFetching] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [guilds, setGuilds] = useState<AdminGuild[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const fetchRooms = async () => {
    if (inFlight.current) return; // avoid overlapping polls
    inFlight.current = true;
    try {
      const res = await fetch("/api/admin/rooms", { credentials: "include" });
      if (!res.ok) {
        setLoadError(
          res.status === 403 ? "ERR_403: not_authorized;" : "ERR: registry_fetch_failed;"
        );
        return;
      }
      const data = await res.json();
      setRooms(data.rooms || []);
      setLoadError(null);
    } catch {
      setLoadError("ERR: registry_fetch_failed;");
    } finally {
      inFlight.current = false;
      setFetching(false);
    }
  };

  const fetchGuilds = async () => {
    try {
      const res = await fetch("/api/admin/guilds", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setGuilds(data.guilds || []);
      }
    } catch {}
  };

  // Initial load + live polling (presence / idle age go stale immediately).
  useEffect(() => {
    if (loading || !user?.isAdmin) return;
    fetchRooms();
    fetchGuilds();
    const t = setInterval(() => { fetchRooms(); fetchGuilds(); }, 12_000);
    return () => clearInterval(t);
  }, [loading, user]);

  const deleteRoom = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/rooms/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setConfirmId(null);
        setRooms((prev) => prev.filter((r) => r.id !== id));
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "ERR: delete_failed;");
        setTimeout(() => setError(null), 3000);
      }
    } catch {
      setError("ERR: delete_failed;");
      setTimeout(() => setError(null), 3000);
    } finally {
      setDeletingId(null);
    }
  };

  const approveGuild = async (guildId: string) => {
    if (approvingId) return;
    setApprovingId(guildId);
    try {
      const res = await fetch(`/api/admin/guilds/${guildId}/approve`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        setGuilds((prev) => prev.map((g) => g.id === guildId ? { ...g, approved: true } : g));
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "ERR: approve_failed;");
        setTimeout(() => setError(null), 3000);
      }
    } catch {
      setError("ERR: approve_failed;");
      setTimeout(() => setError(null), 3000);
    } finally {
      setApprovingId(null);
    }
  };

  const rejectGuild = async (guildId: string) => {
    if (approvingId) return;
    setApprovingId(guildId);
    try {
      const res = await fetch(`/api/admin/guilds/${guildId}/reject`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        setGuilds((prev) => prev.filter((g) => g.id !== guildId));
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "ERR: reject_failed;");
        setTimeout(() => setError(null), 3000);
      }
    } catch {
      setError("ERR: reject_failed;");
      setTimeout(() => setError(null), 3000);
    } finally {
      setApprovingId(null);
    }
  };

  // Loading shell — render neutral chrome while auth resolves so non-admins
  // never glimpse the moderation console.
  if (loading) {
    return (
      <div className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-1 flex items-center justify-center p-8">
          <div className="w-2 h-2 bg-ps-steel-500 rounded-full" style={{ animation: "ps-pulse 1.2s ease-in-out infinite" }} />
        </main>
      </div>
    );
  }

  // Authorization gate (the server is the real boundary; this avoids exposing
  // the console chrome to non-admins).
  if (!user?.isAdmin) {
    return (
      <div className="min-h-screen flex flex-col">
        <Navbar />
        <main className="flex-1 flex items-center justify-center p-8">
          <div className="text-center space-y-4">
            <Glyph name="no-symbol" className="w-10 h-10 mx-auto text-ps-signal-danger" />
            <p className="text-sm font-mono text-ps-signal-danger tracking-wide">
              ERR_403: not_authorized;
            </p>
            <Link
              to="/"
              className="inline-block text-[11px] font-mono text-ps-iris-cyan hover:text-ps-iris-lilac transition-colors duration-120"
            >
              ///return_home;
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <main className="flex-1 w-full max-w-5xl mx-auto p-4 sm:p-8 lg:p-10">
        {/* Console header */}
        <div className="mb-8 lg:mb-10">
          <div className="flex items-center gap-2 mb-2">
            <Glyph name="shield" className="w-3.5 h-3.5 text-ps-iris-cyan" />
            <span className="text-[10px] font-mono text-ps-steel-400 tracking-[0.14em] uppercase">
              ///admin;
            </span>
          </div>
          <h1 className="font-display font-bold text-3xl lg:text-4xl tracking-tight text-ps-fg-inv-1">
            DASHBOARD
          </h1>
          <div className="ps-shimmer-bar w-full mt-3 opacity-50" />
        </div>

        {/* Guild approvals */}
        {(() => {
          const pending = guilds.filter((g) => !g.approved);
          const approvedList = guilds.filter((g) => g.approved);
          if (pending.length === 0 && approvedList.length === 0) return null;
          return (
            <div className="mb-8 lg:mb-10">
              <div className="flex items-end justify-between gap-4 mb-4">
                <h2 className="font-display font-bold text-xl tracking-tight text-ps-fg-inv-1">
                  GUILD_APPROVALS
                </h2>
                {pending.length > 0 && (
                  <span className="text-[10px] font-mono text-ps-steel-400 tracking-wide">
                    {pending.length} _pending;
                  </span>
                )}
              </div>

              {pending.length > 0 && (
                <div className="border border-white/10">
                  {pending.map((guild) => (
                    <div
                      key={guild.id}
                      className="flex items-center gap-4 px-4 py-3 border-b border-white/10 last:border-b-0"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="font-mono text-xs text-ps-iris-cyan truncate">
                          {guild.name || guild.id}
                        </p>
                        <p className="font-mono text-[10px] text-ps-steel-400 truncate">
                          _by:{guild.requestedByUsername || guild.requestedBy || "—"}
                        </p>
                      </div>
                      <span className="text-[10px] font-mono text-ps-steel-400 shrink-0">
                        {timeAgo(guild.requestedAt)}
                      </span>
                      <button
                        onClick={() => approveGuild(guild.id)}
                        disabled={approvingId === guild.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-ps-signal-ok/30 bg-ps-signal-ok/10 text-ps-signal-ok text-[9px] font-mono font-bold tracking-wide hover:bg-ps-signal-ok/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-120"
                        style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
                      >
                        <Glyph name="check" className="w-3 h-3" />
                        APPROVE;
                      </button>
                      <button
                        onClick={() => rejectGuild(guild.id)}
                        disabled={approvingId === guild.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 bg-ps-graphite-600 text-ps-steel-400 text-[9px] font-mono tracking-wide hover:text-ps-signal-danger hover:border-ps-signal-danger/30 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-120"
                        style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
                      >
                        REJECT;
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {approvedList.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {approvedList.map((guild) => (
                    <div
                      key={guild.id}
                      className="flex items-center gap-2 px-3 py-1.5 bg-ps-graphite-700 border border-white/10"
                    >
                      <span className="w-1.5 h-1.5 bg-ps-signal-ok rounded-full" />
                      <span className="text-[10px] font-mono text-ps-fg-inv-2">
                        {guild.name || guild.id}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* Room registry */}
        <div className="mb-6">
          <div className="flex items-end justify-between gap-4">
            <h2 className="font-display font-bold text-xl tracking-tight text-ps-fg-inv-1">
              ROOM_REGISTRY
            </h2>
            <span className="text-[10px] font-mono text-ps-steel-400 tracking-wide">
              {rooms.length} _rooms;
            </span>
          </div>
          <div className="ps-shimmer-bar w-full mt-3 opacity-50" />
        </div>

        {fetching ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-14 bg-ps-graphite-700 animate-pulse" />
            ))}
          </div>
        ) : loadError ? (
          <div className="text-center py-20 space-y-3">
            <Glyph name="no-symbol" className="w-8 h-8 mx-auto text-ps-signal-danger" />
            <p className="text-[11px] font-mono text-ps-signal-danger tracking-wide">
              {loadError}
            </p>
          </div>
        ) : rooms.length === 0 ? (
          <div className="text-center py-20 space-y-3">
            <Glyph name="no-symbol" className="w-8 h-8 mx-auto text-ps-steel-400" />
            <p className="text-[11px] font-mono text-ps-steel-400 tracking-wide">
              // no_rooms_registered;
            </p>
          </div>
        ) : (
          <div className="border border-white/10">
            {/* Legend */}
            <div className="flex items-center gap-4 px-4 py-2 border-b border-white/10 bg-ps-graphite-700 text-[10px] font-mono text-ps-steel-400 tracking-[0.14em] uppercase">
              <span className="flex-1">_room; / _owner;</span>
              <span className="w-10 text-right">here;</span>
              <span className="w-14 text-right hidden sm:block">queue;</span>
              <span className="w-12 text-right">idle;</span>
              <span className="w-16" />
            </div>

            {rooms.map((room) => (
              <div
                key={room.id}
                className="flex items-center gap-4 px-4 py-3 border-b border-white/10 last:border-b-0 hover:bg-ps-graphite-700/60 transition-colors duration-120"
              >
                <div className="flex-1 min-w-0">
                  <Link
                    to={`/room/${room.id}`}
                    className="block font-mono text-xs text-ps-iris-cyan hover:text-ps-iris-lilac truncate transition-colors duration-120"
                  >
                    {room.id}
                  </Link>
                  <span className="block font-mono text-[10px] text-ps-steel-400 truncate">
                    _by:{room.ownerName || "—"}
                  </span>
                </div>

                <span className="w-10 flex items-center justify-end gap-1 font-mono text-[11px] text-ps-fg-inv-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      room.presentCount > 0 ? "bg-ps-signal-ok" : "bg-ps-steel-500"
                    }`}
                  />
                  {room.presentCount}
                </span>

                <span className="w-14 text-right font-mono text-[11px] text-ps-steel-400 hidden sm:block">
                  {room.pendingCount}/{room.songCount}
                </span>

                <span className="w-12 text-right font-mono text-[11px] text-ps-steel-400">
                  {timeAgo(room.lastActivityAt)}
                </span>

                <div className="w-16 flex justify-end">
                  {confirmId === room.id ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => deleteRoom(room.id)}
                        disabled={deletingId === room.id}
                        className="px-2 py-1 bg-ps-signal-danger hover:opacity-90 disabled:opacity-50 text-[9px] font-mono font-bold text-ps-ink-900 tracking-wide transition-all duration-120"
                      >
                        DEL;
                      </button>
                      <button
                        onClick={() => setConfirmId(null)}
                        className="px-2 py-1 bg-ps-graphite-600 hover:bg-ps-graphite-700 border border-white/10 text-[9px] font-mono text-ps-fg-inv-2 tracking-wide transition-all duration-120"
                      >
                        NO;
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmId(room.id)}
                      title="_delete_room;"
                      className="w-7 h-7 flex items-center justify-center text-ps-steel-400 hover:text-ps-signal-danger transition-all duration-120"
                    >
                      <Glyph name="target-x" className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div
            className="fixed bottom-6 right-6 px-4 py-3 bg-ps-ink-800 border border-ps-signal-danger/30 text-ps-signal-danger text-xs font-mono tracking-wide"
            style={{ boxShadow: "var(--ps-shadow-deep)" }}
          >
            {error}
          </div>
        )}
      </main>
    </div>
  );
}
