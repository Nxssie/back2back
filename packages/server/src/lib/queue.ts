// Queue rendering for the /queue panel. Pure and Discord-free so the layout
// rules that Discord rejects on (per-line length, total message budget) are
// unit-testable instead of only discoverable in a live guild.

export const QUEUE_PAGE_SIZE = 10;

// Discord's limit for an embed description. Content messages cap at 2000, so
// callers replying with plain content must pass their own budget.
export const MESSAGE_LIMIT = 4096;

const TITLE_LIMIT = 60;
const ADDER_LIMIT = 32;

export type QueueSong = {
  id: number;
  title: string | null;
  videoId: string;
  votes: number | null;
  addedBy: string | null;
  addedByUserId: string | null;
};

export type QueuePage = {
  text: string;
  total: number;
  page: number;
  pageCount: number;
  // True when the budget forced lines off the page. Long queues are paginated,
  // not truncated, so this is false for them.
  truncated: boolean;
};

function ellipsize(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function pageCount(total: number, pageSize = QUEUE_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function clampPage(page: number, total: number, pageSize = QUEUE_PAGE_SIZE): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), pageCount(total, pageSize));
}

export function slicePage<T>(items: T[], page: number, pageSize = QUEUE_PAGE_SIZE): T[] {
  const start = (clampPage(page, items.length, pageSize) - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function formatQueueLine(song: QueueSong, position: number): string {
  const title = ellipsize(song.title?.trim() || song.videoId, TITLE_LIMIT);
  const votes = song.votes ?? 0;
  const adder = song.addedBy ? ` · by ${ellipsize(song.addedBy, ADDER_LIMIT)}` : "";
  return `${position}. **${title}** — ${votes} vote${votes === 1 ? "" : "s"}${adder}`;
}

export function formatQueuePage(
  songs: QueueSong[],
  page: number,
  options: { pageSize?: number; maxLength?: number } = {}
): QueuePage {
  const pageSize = options.pageSize ?? QUEUE_PAGE_SIZE;
  const maxLength = options.maxLength ?? MESSAGE_LIMIT;
  const total = songs.length;

  if (total === 0) {
    return { text: "📭 The queue is empty.", total: 0, page: 1, pageCount: 1, truncated: false };
  }

  const pageCountValue = pageCount(total, pageSize);
  const currentPage = clampPage(page, total, pageSize);
  const offset = (currentPage - 1) * pageSize;
  const window = slicePage(songs, currentPage, pageSize);

  const header = `**Page ${currentPage}/${pageCountValue}** · ${total} song${total === 1 ? "" : "s"}`;
  const kept: string[] = [];
  let used = header.length;

  for (const [index, song] of window.entries()) {
    const line = formatQueueLine(song, offset + index + 1);
    if (used + 1 + line.length > maxLength) break;
    kept.push(line);
    used += 1 + line.length;
  }

  const truncated = kept.length < window.length;

  if (truncated) {
    // Reserve the note's budget up front: an unbudgeted suffix would push the
    // text back over the limit that just forced the truncation.
    const note = `\n…and ${total - kept.length} more`;
    if (used + note.length <= maxLength) {
      kept.push(note.slice(1));
      used += note.length;
    }
  }

  const text = [header, ...kept].join("\n");
  // Last-resort guard: a pathological budget must never produce a message
  // Discord will reject outright.
  return {
    text: text.length <= maxLength ? text : ellipsize(text, maxLength),
    total,
    page: currentPage,
    pageCount: pageCountValue,
    truncated,
  };
}
