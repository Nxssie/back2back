import { memo, useEffect, useRef, useState } from "react";
import { fetchLyrics, getCurrentLineIndex, type LrcLine } from "../lib/lyrics";

interface LyricsPanelProps {
  songId: number;
  title: string | null;
  uploader: string | null;
  startedAt: number | null;
}

// Self-contained lyrics panel. It owns the lyrics state AND the 250ms sync tick,
// so the 4x/sec update only re-renders this subtree — not the Room queue with
// its ~50 SongItems, which is what previously caused sustained jank.
function LyricsPanel({ songId, title, uploader, startedAt }: LyricsPanelProps) {
  const [lines, setLines] = useState<LrcLine[]>([]);
  const [plain, setPlain] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [currentLineIdx, setCurrentLineIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch lyrics when the song changes.
  useEffect(() => {
    if (!title) {
      setLines([]);
      setPlain(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLines([]);
    setPlain(null);
    setCurrentLineIdx(-1);
    fetchLyrics(title, uploader).then((result) => {
      if (cancelled) return;
      setLines(result?.lines ?? []);
      setPlain(result?.plain ?? null);
      setLoading(false);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId]);

  // Tick elapsed time to keep the current lyric line in sync.
  useEffect(() => {
    if (!lines.length || !startedAt || !open) return;
    const tick = () => setCurrentLineIdx(getCurrentLineIndex(lines, Date.now() - startedAt));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [lines, startedAt, open]);

  // Keep the active line centered — never touches the outer sidebar.
  useEffect(() => {
    if (currentLineIdx < 0 || !containerRef.current) return;
    const container = containerRef.current;
    const activeLine = container.children[currentLineIdx] as HTMLElement | null;
    if (!activeLine) return;
    const containerRect = container.getBoundingClientRect();
    const lineRect = activeLine.getBoundingClientRect();
    const lineTop = lineRect.top - containerRect.top + container.scrollTop;
    const target = lineTop + lineRect.height / 2 - container.clientHeight / 2;
    container.scrollTop = Math.max(0, target);
  }, [currentLineIdx]);

  if (!loading && lines.length === 0 && !plain) return null;

  return (
    <div className="border-t border-white/10">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-2.5 text-[9px] font-mono tracking-[0.14em] uppercase text-ps-steel-400 hover:text-ps-iris-lilac transition-colors"
      >
        <span>_lyrics;</span>
        <span className="text-ps-steel-400/60">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div
          ref={containerRef}
          className="px-5 pb-5 max-h-64 overflow-y-auto space-y-0.5"
          style={{ scrollbarWidth: "none" }}
        >
          {loading ? (
            <p className="text-[10px] font-mono text-ps-steel-400/50 animate-pulse">_searching_lyrics;</p>
          ) : lines.length > 0 ? (
            lines.map((line, i) => {
              const isActive = i === currentLineIdx;
              const isPast = i < currentLineIdx;
              return (
                <div
                  key={i}
                  className={[
                    "text-[11px] font-mono leading-relaxed py-0.5 transition-all duration-300",
                    isActive
                      ? "text-ps-iris-cyan font-semibold scale-[1.02] origin-left"
                      : isPast
                      ? "text-ps-steel-400/40"
                      : "text-ps-steel-400/70",
                  ].join(" ")}
                >
                  {line.text}
                </div>
              );
            })
          ) : (
            <div className="text-[10px] font-mono text-ps-steel-400/60 leading-relaxed whitespace-pre-line">
              {plain}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(LyricsPanel);
