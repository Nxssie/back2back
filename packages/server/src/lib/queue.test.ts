import { test, expect } from "bun:test";
import {
  QUEUE_PAGE_SIZE,
  clampPage,
  formatQueueLine,
  formatQueuePage,
  pageCount,
  slicePage,
  type QueueSong,
} from "./queue";

function song(overrides: Partial<QueueSong> = {}): QueueSong {
  return {
    id: 1,
    title: "Track",
    videoId: "abc123",
    votes: 0,
    addedBy: "alice",
    addedByUserId: "1",
    ...overrides,
  };
}

test("pageCount: an empty queue still has one page", () => {
  expect(pageCount(0)).toBe(1);
});

test("pageCount: rounds up to the last partial page", () => {
  expect(pageCount(1)).toBe(1);
  expect(pageCount(QUEUE_PAGE_SIZE)).toBe(1);
  expect(pageCount(QUEUE_PAGE_SIZE + 1)).toBe(2);
  expect(pageCount(25)).toBe(3);
});

test("clampPage: keeps an in-range page untouched", () => {
  expect(clampPage(2, 25)).toBe(2);
});

test("clampPage: pulls out-of-range pages into the valid range", () => {
  expect(clampPage(0, 25)).toBe(1);
  expect(clampPage(-5, 25)).toBe(1);
  expect(clampPage(99, 25)).toBe(3);
  expect(clampPage(99, 0)).toBe(1);
});

test("slicePage: returns the requested window of the queue", () => {
  const items = Array.from({ length: 25 }, (_, i) => i);
  expect(slicePage(items, 1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  expect(slicePage(items, 2)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  expect(slicePage(items, 3)).toEqual([20, 21, 22, 23, 24]);
});

test("slicePage: an out-of-range page slices the clamped one instead of returning nothing", () => {
  const items = Array.from({ length: 25 }, (_, i) => i);
  expect(slicePage(items, 99)).toEqual([20, 21, 22, 23, 24]);
  expect(slicePage(items, 0)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("formatQueueLine: carries position, title, votes, and adder", () => {
  const line = formatQueueLine(song({ title: "Bohemian Rhapsody", votes: 3, addedBy: "alice" }), 1);
  expect(line).toContain("1.");
  expect(line).toContain("Bohemian Rhapsody");
  expect(line).toContain("3");
  expect(line).toContain("alice");
});

test("formatQueueLine: falls back to the video id when there is no title", () => {
  const line = formatQueueLine(song({ title: null, videoId: "dQw4w9WgXcQ" }), 4);
  expect(line).toContain("dQw4w9WgXcQ");
});

test("formatQueueLine: tolerates a null vote count and a null adder", () => {
  const line = formatQueueLine(song({ votes: null, addedBy: null }), 1);
  expect(line).toContain("0");
  expect(line.length).toBeLessThan(140);
});

// A single pathological title must not be able to blow the message budget on
// its own — Discord rejects the whole reply, not just the offending line.
test("formatQueueLine: truncates a pathologically long title", () => {
  const line = formatQueueLine(song({ title: "x".repeat(500) }), 1);
  expect(line.length).toBeLessThanOrEqual(140);
  expect(line).toContain("…");
});

test("formatQueuePage: renders a short queue in full", () => {
  const songs = [song({ id: 1, title: "A" }), song({ id: 2, title: "B" })];
  const page = formatQueuePage(songs, 1);
  expect(page.total).toBe(2);
  expect(page.pageCount).toBe(1);
  expect(page.page).toBe(1);
  expect(page.truncated).toBe(false);
  expect(page.text).toContain("A");
  expect(page.text).toContain("B");
});

test("formatQueuePage: reports absolute positions across pages", () => {
  const songs = Array.from({ length: 25 }, (_, i) => song({ id: i + 1, title: `T${i + 1}` }));
  const page = formatQueuePage(songs, 3);
  expect(page.text).toContain("21.");
  expect(page.text).not.toContain("**T1**");
  expect(page.text).not.toContain("**T20**");
});

// Regression: /queue used to join every unplayed song with no cap, so a queue
// past ~20 songs made Discord reject the reply. Long queues are now paginated
// rather than budget-truncated, so the whole queue stays reachable.
test("formatQueuePage: a 200-song queue paginates instead of overflowing", () => {
  const songs = Array.from({ length: 200 }, (_, i) =>
    song({ id: i + 1, title: `Some reasonably long track title number ${i + 1}` })
  );
  const page = formatQueuePage(songs, 1);
  expect(page.pageCount).toBe(20);
  expect(page.text.length).toBeLessThanOrEqual(4096);
  expect(page.truncated).toBe(false);
  expect(page.text).not.toContain("**Some reasonably long track title number 11**");
});

test("formatQueuePage: budget-truncates when a single page cannot fit", () => {
  const songs = Array.from({ length: 200 }, (_, i) => song({ id: i + 1, title: `Title ${i + 1}` }));
  const page = formatQueuePage(songs, 1, { pageSize: 200, maxLength: 500 });
  expect(page.text.length).toBeLessThanOrEqual(500);
  expect(page.truncated).toBe(true);
});

test("formatQueuePage: honours a caller-supplied budget", () => {
  const songs = Array.from({ length: 50 }, (_, i) => song({ id: i + 1, title: `Title ${i + 1}` }));
  const page = formatQueuePage(songs, 1, { maxLength: 200 });
  expect(page.text.length).toBeLessThanOrEqual(200);
  expect(page.truncated).toBe(true);
});

test("formatQueuePage: never exceeds the budget even for a single oversized entry", () => {
  const songs = [song({ title: "y".repeat(400) }), song({ title: "z".repeat(400) })];
  const page = formatQueuePage(songs, 1, { maxLength: 120 });
  expect(page.text.length).toBeLessThanOrEqual(120);
});

test("formatQueuePage: clamps an out-of-range page and still reports the real page count", () => {
  const songs = Array.from({ length: 25 }, (_, i) => song({ id: i + 1, title: `T${i + 1}` }));
  const page = formatQueuePage(songs, 99);
  expect(page.page).toBe(3);
  expect(page.pageCount).toBe(3);
  expect(page.text).toContain("21.");
});

test("formatQueuePage: an empty queue explains itself", () => {
  const page = formatQueuePage([], 1);
  expect(page.total).toBe(0);
  expect(page.pageCount).toBe(1);
  expect(page.text.toLowerCase()).toContain("empty");
});
