import { test, expect } from "bun:test";
import { DISCORD_MESSAGE_LIMIT, formatLyrics } from "./lyrics";

test("formatLyrics: prefers the plain lyrics over the synced lines", () => {
  const text = formatLyrics({
    plain: "Is this the real life?\nIs this just fantasy?",
    lines: [{ timeMs: 1000, text: "WRONG" }],
  });
  expect(text).toContain("Is this the real life?");
  expect(text).not.toContain("WRONG");
});

test("formatLyrics: falls back to the synced line text when there are no plain lyrics", () => {
  const text = formatLyrics({
    plain: null,
    lines: [
      { timeMs: 1000, text: "First line" },
      { timeMs: 4000, text: "Second line" },
    ],
  });
  expect(text).toBe("First line\nSecond line");
});

test("formatLyrics: returns null when there is nothing to show", () => {
  expect(formatLyrics({ plain: null, lines: [] })).toBeNull();
  expect(formatLyrics({ plain: "", lines: [] })).toBeNull();
  expect(formatLyrics({ plain: "   \n  ", lines: [] })).toBeNull();
});

test("formatLyrics: trims the plain payload", () => {
  expect(formatLyrics({ plain: "\n\n  Hello  \n\n", lines: [] })).toBe("Hello");
});

test("formatLyrics: a long payload fits Discord's 2000-character message limit", () => {
  const text = formatLyrics({ plain: "line of lyrics\n".repeat(1000), lines: [] });
  expect(text).not.toBeNull();
  expect(text!.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
  expect(text).toContain("…");
});

test("formatLyrics: honours a caller-supplied budget", () => {
  const text = formatLyrics({ plain: "x".repeat(5000), lines: [] }, 100);
  expect(text!.length).toBeLessThanOrEqual(100);
});
