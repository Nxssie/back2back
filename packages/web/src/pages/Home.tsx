import { useState } from "react";
import { useNavigate } from "react-router-dom";
import Navbar from "../components/Navbar";
import Glyph from "../components/Glyph";
import ReticleCorners from "../components/ReticleCorners";
import { useAuth } from "../hooks/useAuth";

export default function Home() {
  const [roomId, setRoomId] = useState("");
  const navigate = useNavigate();
  const { user, loading, login } = useAuth();

  const createRoom = () => {
    const id = Math.random().toString(36).substring(2, 8);
    navigate(`/room/${id}`);
  };

  const joinRoom = (e: React.FormEvent) => {
    e.preventDefault();
    if (roomId.trim()) {
      navigate(`/room/${roomId.trim()}`);
    }
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <main className="flex-1 flex items-center justify-center p-8">
        <div className="max-w-md w-full space-y-20">
          {/* Hero */}
          <div className="text-center space-y-10">
            {/* Glyph mark */}
            <div className="relative inline-flex items-center justify-center">
              <div className="relative w-20 h-20 border border-white/10 bg-ps-graphite-700 flex items-center justify-center text-ps-pearl-200"
                style={{ boxShadow: "var(--ps-shadow-card)" }}>
                <Glyph name="xxxy" className="w-11 h-auto opacity-90" />
                <ReticleCorners className="text-ps-iris-cyan/60" />
              </div>
              <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-ps-iris-cyan rounded-full" style={{ animation: "ps-pulse 2s ease-in-out infinite" }} />
            </div>

            <div className="space-y-4">
              <h1 className="font-display font-bold text-5xl tracking-tight leading-none text-ps-fg-inv-1">
                BACK<span className="text-ps-steel-400">2</span>BACK
              </h1>
              <p className="text-sm font-mono text-ps-steel-400 tracking-wide">
                _sync_music_with_care;
              </p>
              <div className="ps-shimmer-bar w-24 mx-auto" />
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-5">
            <button
              onClick={createRoom}
              className="group relative w-full py-5 px-6 bg-ps-white text-ps-ink-900 font-mono font-bold text-sm tracking-[0.14em] uppercase transition-all duration-120 hover:bg-ps-pearl-100"
              style={{
                boxShadow: "var(--ps-shadow-card)",
                transitionTimingFunction: "var(--ps-ease-print)",
              }}
            >
              <span className="relative z-10">CREATE_ROOM;</span>
              <div className="absolute bottom-0 left-0 right-0 h-[2px] ps-shimmer-bar opacity-0 group-hover:opacity-100 transition-opacity duration-120" />
            </button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/10" />
              </div>
              <div className="relative flex justify-center">
                <span className="px-4 bg-ps-ink-900 text-[10px] font-mono text-ps-steel-400 tracking-[0.14em] uppercase">
                  ///or_join;
                </span>
              </div>
            </div>

            <form onSubmit={joinRoom} className="flex gap-3">
              <input
                type="text"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                placeholder="_room_id;"
                className="flex-1 px-5 py-4 bg-ps-graphite-700 border border-white/10 text-ps-fg-inv-1 placeholder-ps-steel-400 font-mono text-sm tracking-wide focus:outline-none focus:border-ps-iris-cyan/40 transition-all duration-120"
                style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
              />
              <button
                type="submit"
                disabled={!roomId.trim()}
                className="px-7 py-4 bg-ps-graphite-600 hover:bg-ps-graphite-700 disabled:opacity-30 disabled:cursor-not-allowed border border-white/10 font-mono text-xs font-medium text-ps-fg-inv-1 tracking-[0.14em] uppercase transition-all duration-120"
                style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
              >
                JOIN;
              </button>
            </form>
          </div>

          {/* Status */}
          <div className="text-center pt-4 space-y-3">
            <p className="text-[11px] font-mono text-ps-steel-400 tracking-wide">
              {loading ? (
                <span className="inline-block w-20 h-3 bg-ps-graphite-600 animate-pulse" />
              ) : user ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-1.5 h-1.5 bg-ps-signal-ok rounded-full" />
                  _authenticated: <span className="text-ps-fg-inv-2">{user.username}</span>
                </span>
              ) : (
                <button onClick={login} className="text-ps-iris-cyan hover:text-ps-iris-lilac transition-colors duration-120">
                  ///connect_discord;
                </button>
              )}
            </p>
            <a
              href="/api/bot/invite"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-[10px] font-mono text-ps-steel-400 hover:text-ps-iris-cyan tracking-wide transition-colors duration-120"
            >
              <Glyph name="plus" className="w-3 h-3" />
              ///invite_bot;
            </a>
          </div>

          {/* Footer barcode */}
          <div className="flex justify-center text-ps-steel-400 opacity-30">
            <Glyph name="barcode" className="h-4 w-auto" />
          </div>
        </div>
      </main>
    </div>
  );
}
