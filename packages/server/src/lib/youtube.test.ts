import { test, expect } from "bun:test";
import { extractVideoId, isPlaylistUrl } from "./youtube";

test("extractVideoId: standard watch URL", () => {
  expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
    "dQw4w9WgXcQ"
  );
});

test("extractVideoId: youtu.be short URL", () => {
  expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

test("extractVideoId: youtu.be with tracking query", () => {
  expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?si=abc123")).toBe(
    "dQw4w9WgXcQ"
  );
});

test("extractVideoId: bare 11-char id", () => {
  expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
});

test("extractVideoId: rejects shell-metachar payloads (RCE guard)", () => {
  expect(extractVideoId('https://youtu.be/x" ; touch /tmp/pwn ; "')).toBeNull();
  expect(extractVideoId("https://youtu.be/x$(id)")).toBeNull();
  expect(extractVideoId("https://youtu.be/`whoami`")).toBeNull();
});

test("extractVideoId: rejects non-youtube / garbage", () => {
  expect(extractVideoId("https://example.com/watch?v=abc")).toBeNull();
  expect(extractVideoId("not a url at all")).toBeNull();
});

test("isPlaylistUrl: list without v is a playlist", () => {
  expect(isPlaylistUrl("https://www.youtube.com/playlist?list=PLabc")).toBe(true);
});

test("isPlaylistUrl: watch?v=..&list=.. is a single video", () => {
  expect(
    isPlaylistUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc")
  ).toBe(false);
});

test("isPlaylistUrl: plain video is not a playlist", () => {
  expect(isPlaylistUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(false);
});
