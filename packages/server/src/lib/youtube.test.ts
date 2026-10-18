import { test, expect } from "bun:test";
import { extractVideoId, isPlaylistUrl, isRadioUrl } from "./youtube";

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

test("isRadioUrl: watch URL with an RD list is a radio", () => {
  expect(
    isRadioUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1")
  ).toBe(true);
});

test("isRadioUrl: YouTube Music RDAMVM radio", () => {
  expect(
    isRadioUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVMdQw4w9WgXcQ")
  ).toBe(true);
});

test("isRadioUrl: watch URL with a regular PL list is not a radio", () => {
  expect(
    isRadioUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc")
  ).toBe(false);
});

test("isRadioUrl: playlist?list=RD without v is not a radio", () => {
  expect(isRadioUrl("https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ")).toBe(false);
});

test("isRadioUrl: non-YouTube host is not a radio", () => {
  expect(
    isRadioUrl("https://example.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ")
  ).toBe(false);
});

test("isRadioUrl: garbage never throws", () => {
  expect(isRadioUrl("not a url at all")).toBe(false);
  expect(isRadioUrl("")).toBe(false);
});
