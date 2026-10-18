# Feature: YouTube radio links and a faster first play

A YouTube radio ("Mix") link pasted into `/play` must queue the radio's songs,
and the silence before a song starts must shrink.

## Status

| Field | Value |
|---|---|
| State | **Code complete** — checks green; review assessment below |
| Branch | `feat/youtube-radio-fast-start`, stacked on `fix/queue-reset-on-leave` (both rework `index.ts`; the base PR is not open yet) |
| Tasks | 3 |
| TDD | off (no project or session configuration enables it); runner `bun test` in `packages/server` |
| Delivery | `ask-on-risk`; forecast ~250 authored lines, under the ~400 slice budget |
| Commit author | `nxssie <dev@nxssie.com>`, no AI attribution trailers |

## Specs

- **S1** — the user's request, verbatim: «si meto un enlace de radio de youtube
  se adquiera esa lista de canciones». A YouTube or YouTube Music URL whose
  `list` parameter starts with `RD` is a radio, even when it carries `v=`
  (radio links always do). It is queued as a playlist.
- **S2** — the user's choice: a radio queues its first **25** songs. Measured:
  `--playlist-end 25` resolves in 1.3 s; an unlimited radio returned 360 songs
  in 15.4 s, inside `resolvePlaylist`'s 30 s timeout but far too slow. A
  `playlist?list=RD…` URL without `v=` is rejected by YouTube ("This playlist
  type is unviewable"), so only the `watch` form is a radio.
- **S3** — `watch?v=X&list=PL…` (a regular playlist with a video) keeps playing
  the single video, as `isPlaylistUrl` documents today.
- **S4** — the user's request, verbatim: «arreglar la velocidad antes de la
  primera reproducción». Root cause: a YouTube `/play` runs two full yt-dlp
  extractions back to back, `getVideoInfo` for the title and then
  `createAudioStream` for the audio. Measured locally: first audio byte ~2.0 s
  through a fresh extraction, ~0.5 s through `--load-info-json -` fed with an
  earlier `-J` extraction.
- **S5** — resolution extracts once (`-J`), keeps the info JSON in a bounded,
  short-lived in-memory cache keyed by the song URL, and returns title,
  uploader and thumbnail from it. `createAudioStream` streams from a cached
  entry through `--load-info-json -` (stdin, no temp file) and consumes it; a
  missing or expired entry falls back to today's fresh extraction. The TTL is
  well under the lifetime of YouTube's signed media URLs, so a cached entry
  never streams from an expired URL.
- **S6** — `README.md` lists radio links among the supported inputs.
- **S7** — checks: `bun test`, `bun build src/index.ts --target bun`. No live
  Discord smoke (no harness in this repo).

## Tasks

- [x] **T1** — Radio links (S1, S2, S3, S6): `isRadioUrl` in `lib/youtube.ts`
      with tests; `/play` routes radios through `resolvePlaylist` with a
      25-song limit; README. `1be4029`
- [x] **T2** — Fast first play (S4, S5): pure info cache in `lib/` with tests;
      `-J` resolution for YouTube/generic tracks (resolve and lazy-title
      paths); `createAudioStream` streams from the cache with a fallback. `eac9787`
- [x] **T3** — Checks and evidence (S7).

## Routing

| Task | Route | Trigger evidence |
|---|---|---|
| T1 | delegated writer | `lib/youtube.ts`, its test, `index.ts`, README: 2+ non-trivial files |
| T2 | delegated writer | new `lib` module, its test, `index.ts`: 2+ non-trivial files |
| T3 | inline | runs checks only |

## Evidence

| Check | Result |
|---|---|
| `bun test` | 84 pass, 0 fail (9 files); new: 6 `isRadioUrl` cases, 7 `infoCache` cases |
| `bun build src/index.ts --target bun` | exit 0 |
| Ad-hoc `tsc --strict` | only the 2 pre-existing `member.voice` errors at the voice gates |
| Live radio resolve | `--playlist-end 25` on an `RD` radio: 25 entries in 1.8 s |
| Live first byte | cached info 0.67 s vs fresh extraction 4.99 s (same run) |
| Diff vs base | 6 files, +290 / −29 |

## Accepted deviations

- Cache cap is 20 entries, not 50: info JSON measured 86–660 KB per video, so
  20 entries bound memory at ~13 MB. TTL stays 10 minutes.
- YouTube thumbnails stay null: yt-dlp reports `maxresdefault` without checking
  it exists; the now-playing card already derives `hqdefault.jpg` from the id.

## Known residue

- Only tracks resolved through `getVideoInfo` get the fast start: single
  `/play` tracks and playlist entries without a title. YouTube playlist and
  radio entries arrive titled, so their first song still extracts while
  starting. Prefetching the next song's info during playback would cover them
  and the gap between songs; not in this scope.
- A generic HLS/DASH stream with no audio-only format now gets its URL as the
  title (the `-f bestaudio` extraction fails where `--get-title` did not).
  Such streams already failed to play with the same format selector.

## Log

- **L1** — «también se podría hacer que si meto un enlace de radio de youtube se adquiera esa lista de canciones?»
- **L2** — «pues 25 canciones y arreglar la velocidad antes de la primera reproducción»
