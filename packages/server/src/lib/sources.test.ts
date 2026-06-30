import { test, expect } from "bun:test";
import { detectSource, isSoundcloudSetUrl } from "./sources";

test("detectSource: youtube hosts", () => {
  expect(detectSource("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
  expect(detectSource("https://youtu.be/dQw4w9WgXcQ")).toBe("youtube");
  expect(detectSource("https://music.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
});

test("detectSource: soundcloud hosts", () => {
  expect(detectSource("https://soundcloud.com/forss/flickermood")).toBe("soundcloud");
  expect(detectSource("https://m.soundcloud.com/forss/flickermood")).toBe("soundcloud");
  expect(detectSource("https://on.soundcloud.com/abc123")).toBe("soundcloud");
});

test("detectSource: rejects other hosts and garbage", () => {
  expect(detectSource("https://example.com/watch?v=abc")).toBeNull();
  expect(detectSource("not a url at all")).toBeNull();
  expect(detectSource("")).toBeNull();
});

test("isSoundcloudSetUrl: set/playlist url", () => {
  expect(isSoundcloudSetUrl("https://soundcloud.com/forss/sets/soulhack")).toBe(true);
});

test("isSoundcloudSetUrl: plain track is not a set", () => {
  expect(isSoundcloudSetUrl("https://soundcloud.com/forss/flickermood")).toBe(false);
});

test("isSoundcloudSetUrl: youtube url is never a soundcloud set", () => {
  expect(isSoundcloudSetUrl("https://www.youtube.com/playlist?list=PLabc")).toBe(false);
});
