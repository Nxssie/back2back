import { useState, memo } from "react";
import Glyph from "./Glyph";

interface Song {
  id: number;
  videoId: string;
  source: "youtube" | "soundcloud" | "mixcloud" | "twitch" | "generic";
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

interface SongItemProps {
  song: Song;
  isVoted: boolean;
  canDelete: boolean;
  onVote: (songId: number) => void;
  onDelete: (songId: number) => void;
  onPreview?: (song: Song) => void;
}

function SongItem({ song, isVoted, canDelete, onVote, onDelete, onPreview }: SongItemProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="group relative flex items-center gap-4 p-4 bg-ps-graphite-700 hover:bg-ps-graphite-600 border border-white/10 transition-all duration-120"
      style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
    >
      {/* Vote count / track indicator */}
      <div className="w-7 h-7 flex items-center justify-center shrink-0 border border-white/10 bg-ps-ink-800">
        {song.votes > 0 ? (
          <span className="text-[10px] font-mono font-bold text-ps-iris-cyan">{song.votes}</span>
        ) : (
          <Glyph name="diamond" className="w-3 h-3 text-ps-steel-400" />
        )}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate leading-snug text-ps-fg-inv-1">
          {song.title || song.videoId}
        </p>
        <p className="text-[11px] font-mono text-ps-pearl-300 mt-1 tracking-wide">
          _by:{song.addedBy}
        </p>
      </div>

      {/* Preview */}
      {onPreview && (
        <button
          onClick={() => onPreview(song)}
          title="_preview;"
          className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center text-ps-steel-400 hover:text-ps-iris-cyan transition-all duration-120"
          style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
        >
          <Glyph name="reticle" className="w-3 h-3" />
        </button>
      )}

      {/* Vote button */}

      <button
        onClick={() => onVote(song.id)}
        disabled={isVoted}
        className={`flex items-center justify-center w-7 h-7 border text-[10px] font-mono font-bold transition-all duration-120 ${
          isVoted
            ? "border-ps-iris-cyan/30 bg-ps-iris-cyan/10 text-ps-iris-cyan cursor-default"
            : "border-white/10 bg-ps-ink-800 text-ps-steel-400 hover:border-ps-iris-cyan/30 hover:text-ps-iris-cyan"
        }`}
        style={{ transitionTimingFunction: "var(--ps-ease-print)" }}
        title={isVoted ? "_voted;" : "_upvote;"}
      >
        <Glyph name={isVoted ? "check" : "chevron-up"} className="w-3.5 h-3.5" />
      </button>

      {/* Delete */}
      {canDelete && (
        <div className="relative">
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => onDelete(song.id)}
                className="px-2 py-0.5 text-[9px] font-mono bg-ps-ink-800 hover:bg-ps-signal-danger/25 text-ps-signal-danger border border-ps-signal-danger/40 transition-colors"
              >
                DEL;
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-0.5 text-[9px] font-mono bg-ps-graphite-600 hover:bg-ps-graphite-700 border border-white/10 transition-colors"
              >
                NO;
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              title="_remove;"
              className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center text-ps-steel-400 hover:text-ps-signal-danger transition-all duration-120"
            >
              <Glyph name="target-x" className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Memoized: the queue re-renders on every 4s poll and on unrelated Room state
// changes; with stable props (memoized derivations + useCallback handlers in
// Room) each row only re-renders when its own song/vote state actually changes.
export default memo(SongItem);
