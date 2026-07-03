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

test("detectSource: mixcloud hosts", () => {
  expect(detectSource("https://www.mixcloud.com/user/mix-name/")).toBe("mixcloud");
  expect(detectSource("https://mixcloud.com/user/mix-name/")).toBe("mixcloud");
});

test("detectSource: twitch hosts", () => {
  expect(detectSource("https://www.twitch.tv/videos/1234567890")).toBe("twitch");
  expect(detectSource("https://twitch.tv/videos/1234567890")).toBe("twitch");
  expect(detectSource("https://clips.twitch.tv/AdoringFluffyTireTheFrank")).toBe("twitch");
  expect(detectSource("https://www.twitch.tv/channel_name")).toBe("twitch");
});

test("detectSource: generic streaming manifests", () => {
  expect(detectSource("https://example.com/live/stream.m3u8")).toBe("generic");
  expect(detectSource("https://cdn.example.com/path/manifest.mpd")).toBe("generic");
  expect(detectSource("https://example.com/stream.m3u8?token=abc")).toBe("generic");
  expect(detectSource("https://example.com/video.mp4")).toBeNull();
  expect(detectSource("https://example.com/live")).toBeNull();
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
