import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import Glyph from "./Glyph";

export default function Navbar() {
  const { user, loading, login, logout } = useAuth();

  return (
    <nav className="sticky top-0 z-30 flex items-center justify-between px-8 py-4 border-b border-white/10 bg-ps-ink-900/80 backdrop-blur-[12px]">
      {/* Pearlescent shimmer bar pinned to the top edge of the bar */}
      <div className="absolute top-0 left-0 right-0 h-[2px] ps-shimmer-bar opacity-80" />

      <Link to="/" className="flex items-center gap-3 group">
        <div className="relative text-ps-iris-rose">
          <Glyph name="heart" className="w-6 h-6" />
          <div className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-ps-iris-cyan rounded-full" style={{ animation: "ps-pulse 2s ease-in-out infinite" }} />
        </div>
        <span className="font-display text-sm font-bold tracking-[0.14em] uppercase text-ps-fg-inv-1">
          B2B;
        </span>
        <span className="hidden sm:inline text-[11px] font-mono text-ps-steel-400 tracking-wide">
          ///back2back
        </span>
      </Link>

      <div className="flex items-center gap-5 min-w-0">
        {loading ? (
          <div className="w-16 h-6 bg-ps-graphite-600 rounded animate-pulse" />
        ) : user ? (
          <div className="flex items-center gap-3 min-w-0">
            {user.isAdmin && (
              <Link
                to="/admin"
                title="_moderation;"
                className="flex items-center gap-1.5 shrink-0 text-[10px] font-mono text-ps-iris-cyan hover:text-ps-iris-lilac tracking-wide transition-colors duration-120"
              >
                <Glyph name="shield" className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">///admin;</span>
              </Link>
            )}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-ps-graphite-600 border border-white/10 rounded min-w-0">
              {user.avatar ? (
                <img src={user.avatar} alt="" className="w-4 h-4 rounded-full shrink-0" />
              ) : (
                <div className="w-4 h-4 shrink-0 rounded-full bg-ps-steel-500 flex items-center justify-center text-[8px] font-mono font-bold">
                  {user.username?.[0]?.toUpperCase() ?? "?"}
                </div>
              )}
              <span className="text-xs font-mono text-ps-fg-inv-2 truncate max-w-[8rem]">{user.username}</span>
            </div>
            <button
              onClick={logout}
              className="shrink-0 text-[10px] font-mono text-ps-steel-400 hover:text-ps-fg-inv-1 tracking-wide transition-colors duration-120"
            >
              _logout;
            </button>
          </div>
        ) : (
          <button
            onClick={login}
            className="flex items-center gap-2 px-4 py-2 bg-ps-graphite-600 hover:bg-ps-graphite-700 border border-white/10 text-ps-fg-inv-1 text-xs font-mono tracking-wider transition-all duration-120"
            style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
            </svg>
            CONNECT;
          </button>
        )}
      </div>
    </nav>
  );
}
