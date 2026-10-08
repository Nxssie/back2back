# Feature: bot-only migration

Remove the web SPA and make the Discord bot the sole interface, with full
feature parity via slash commands and message components.

## Status

| Field | Value |
|---|---|
| State | **Code complete** — 19 of 20 tasks; A13 (live Discord smoke) outstanding |
| Branch | `feat/bot-only-migration` — 18 commits, not pushed |
| Slices | A (bot surface) → C (delete web + auth) → B (room semantics) → deploy/docs |
| Tasks | 20 (+3 found during execution) |
| Blocked on the user | A13 live smoke test · `.env.example` rewrite (tool policy) · re-inviting the bot with `Embed Links` |

Slices were reordered during execution: **C before B**. Deleting the web's routes
first meant B simplified only surviving code, instead of editing routes that were
about to disappear. The original order existed to keep the SPA usable during A's
verification; once the user waived the live smoke gate, the cleaner order won.

## Decisions locked

| Decision | Choice |
|---|---|
| Scope | Full removal of `packages/web` + the OAuth/JWT layer |
| Search UX | `/search <query>` → ephemeral select menu. Not autocomplete. |
| Room identity | `roomId == guildId` |
| Lyrics | `/lyrics` plain text. **Synced/karaoke playback dropped.** |
| Presence | Voice-channel membership only |
| HTTP server | Kept, reduced to `/health`, `/ready`, `/metrics` |
| `/metrics` auth | Bearer `METRICS_TOKEN`, **fail closed** when unset (the JWT gate died with the session layer) |
| Old nanoid rooms | Purged once when the guild list is known (B4) |
| `users.token_version` | Dropped via migration 0010 (C5) |
| Commits | One work unit per commit; the user's no-auto-commit rule deliberately suspended for this feature |

## Command surface (shipped)

| Command | Interaction | Replaces |
|---|---|---|
| `/play <url>` | single track **or** playlist/set expansion | `POST /api/rooms/:id/songs` |
| `/search <query> [source]` | ephemeral select menu → queue | in-app search |
| `/queue` | embed + prev/refresh/next + upvote select + remove-mine select | queue page |
| `/lyrics` | ephemeral plain text | lyrics panel |
| `/skip`, `/listen`, `/stop`, `/reset`, `/room` | as before | connect / stop / reset |
| `/admin` | ephemeral embed + approve/reject selects | `/admin` panel |
| `/help` | derived from the registered command array | site discoverability |
| now-playing card | edited per track; Vote skip / Skip / Skip playlist | now-playing card |

## Non-goals

- No new features beyond parity.
- No autocomplete search.
- No karaoke-synced lyrics.
- No changes to audio extraction or the vote/skip algorithms.

## Slice A — additive bot surface

- [x] **A1** Branch. `9229752`
- [x] **A2** `lib/queue.ts` — queue read-model, pagination, budget-safe rendering (18 tests). `d06ca59`
- [x] **A3** `lib/components.ts` — stateless customId codec (10 tests). `14625d6`
- [x] **A4** `lib/search.ts` + `lib/ytdlp.ts` — yt-dlp search extracted (8 tests). `1ba7623`
- [x] **A5** `lib/lyrics.ts` — lyrics server-side + truncation (6 tests). `c86639a`
- [x] **A6** `/search` + `search_pick`; `queueTrackForGuild()` extracted. `6cd1d83`
- [x] **A7** `/queue` panel; `loadQueue()` + `queuePanel()`. `8fd6204`
- [x] **A8** Now-playing card with skip controls. `e2291f4`
- [x] **A9–A12** `/lyrics`, `/admin`, `/help`, registration, approval-gate fix. `a07f6b4`
- [ ] **A13** Live Discord smoke pass — **not executed.** See *Verification*.

## Slice C — delete web + auth

- [x] **C1** `packages/web` deleted; root scripts, `dev.sh`, lockfile updated. `8842019`
- [x] **C2** Auth layer deleted: OAuth routes, `lib/jwt.ts` + tests, `getUser`, cookie/CORS/state, SPA fallback, static serving. `cae0312`
- [x] **C3** Every `/api/*` route deleted; `/health`, `/ready`, `/metrics` kept. `cae0312`
- [x] **C4** Env + Docker cleanup: image drops the Vite stage, compose passes only what the server reads. `227cc85`
- [x] **C5** `users.token_version` dropped via migration `0010_powerful_blob`. `7afd200`
- [x] **C6** README rewritten for a Discord-only product. `c61c26b`
- [ ] **C7** Final smoke on a clean deploy — **not executed**; needs a deploy target.

## Slice B — room semantics

- [x] **B1** `guildRoomMap` and `userCurrentRoom` deleted; the guild is the room. `2f53e0a`
- [x] **B2** `roomPresence()` is voice-only; a browser tab no longer inflates the skip threshold. `2f53e0a`
- [x] **B3** `gcEmptyRooms()` and `/room` simplified. `2f53e0a`
- [x] **B4** `purgeUnreachableRooms()` — nanoid rooms cannot be reached by any code path, so their songs, votes, and rows are dropped once at startup. `2f53e0a`

## Found during execution

Three things this plan did not anticipate:

1. **Playlist support was web-only.** YouTube playlists and SoundCloud sets were
   expanded exclusively by the deleted `POST /api/rooms/:id/songs`, so removing
   the SPA silently dropped the capability. Restored in `df05281`: `/play`
   expands them through the same `queueTrackForGuild` path, plus a *Skip playlist*
   card button mirroring the deleted bulk-skip route's adder-or-admin gate.
   Ordering also gained an `songs.id` tiebreaker — playlist rows share one
   `createdAt` second, so vote ties used to leave their order arbitrary.
2. **The Idle guard depended on the room map.** `teardownGuild` clears
   `currentTracks` before stopping the player and `stop()` emits Idle
   synchronously; the deleted `guildRoomMap.get()` check was what suppressed the
   handler in that window. Removing it repopulated `consecutiveFailures` after
   every teardown, logged a phantom "Track finished (0s)", and leaked a map
   entry. Restored as an explicit `if (!track) return`, which is the same
   condition the old guard was standing in for.
3. **The new UI needs `Embed Links`.** The old bot only sent plain text because
   the web rendered the rich UI, so its invite never requested that permission.
   Discord rejects embeds without it, which would silently kill the now-playing
   card (`publishNowPlaying` catches and logs) and break `/queue`. The correct
   invite is documented in the README with bitfield `36719616`; **existing
   invites must be re-granted**.

## Verification

### Executed

| Check | Result |
|---|---|
| `bun test` | 62 pass, 0 fail, 145 expect() calls, 7 files (was 26 before this feature; JWT tests removed with the layer) |
| Test-first lifecycle on A2–A5 | RED observed for each module (`Cannot find module`), then GREEN |
| Syntax | `bun` transpile of `index.ts` after every change |
| **Server boot smoke** | Real run on a fresh SQLite file: all 11 migrations applied, `/health` → `{"ok":true}`, `/ready` → `{"ok":true,"discord":false}`, `/metrics` → 403 without and with a wrong token, 200 with the right one and the new payload, `GET /` → 404 (no SPA fallback), every deleted route → 404, `SIGTERM` handled and logged |
| Fresh-DB migration | `users` ends with `id, username, avatar, created_at` — `token_version` gone |
| Migration 0010 upgrade path | Against real libSQL on a table with `token_version` populated: column dropped, other columns intact, row data preserved |
| Lockfile | `bun install --frozen-lockfile` reports no changes; no react/vite/tailwind left |
| Dependency prune | 362 → 206 packages; all server dependencies intact; `@discordjs/opus` kept deliberately because the voice stack resolves an opus encoder through it even though nothing imports it |

### Not executed — the honest gap

**No Discord interaction has ever run.** `bun test` never imports `index.ts`,
and the repo has no interaction harness, so `/search`, the `/queue` panel, the
now-playing card, its buttons, `/admin`, `/lyrics`, `/help`, playlist expansion,
and `purgeUnreachableRooms` are verified only by reading, grep, transpile, and
one boot smoke test. The boot smoke proves the process loads, migrates, serves,
and shuts down — it proves nothing about what the buttons do.

A13 is the 15-step checklist in *Slice A smoke checklist* below. It remains the
next real step, and C7 (clean-deploy smoke) is unstarted.

## Risks carried forward

| Risk | Note |
|---|---|
| No automated Discord E2E | Interaction regressions are invisible to CI; the checklist is the only defence |
| Slack token budget | `/play` now swallows playlist resolution into the deferred reply, so a large playlist must resolve inside Discord's 15-minute window |
| `purgeUnreachableRooms` trusts the guild cache | It runs at `ClientReady`, where the cache is populated — asserted, not tested. An under-populated cache would delete reachable rooms |
| Unused `DISCORD_CLIENT_ID` in the server | The server no longer reads it; `deploy-commands.ts` still does |
| `.env.example` is stale | Contains dead `JWT_SECRET`, `FRONTEND_URL`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, and lacks `METRICS_TOKEN`. A tool-level policy blocked the write; the README documents the real config |

## Blocked, needs the user

| Item | Why |
|---|---|
| A13 live smoke | Needs a live Discord app + guild |
| C7 clean-deploy smoke | Needs a deploy target |
| `.env.example` rewrite | Blocked by the safety policy on that path; needs an explicit decision |
| Re-invite with `Embed Links` | The panel and card are embeds; existing grants lack the permission |

## Open questions

Resolved during execution: B4 (purge — the rows are unreachable) and C5 (drop —
only JWT logout used it).

Remaining:
1. Should the queue panel show playlist grouping, as the web view did?
2. Is a moderator force-skip worth adding as a deliberate new privilege, rather
   than the parity-only two-button card?
3. Should `/metrics` be reachable through Traefik at all, or blocked at the edge
   so the token is defence in depth rather than the only control?

## Correction: the `/queue` defect was a crash, not an overflow

This plan originally reported that `/queue` broke past roughly twenty songs
because it joined every unplayed song into one untruncated string.

The real defect was worse. The handler called
`db.select().from(songs)...orderBy(...).all().filter((s) => !s.played)` without
awaiting, and `.all()` returns a **Promise** with the `drizzle-orm/libsql` driver
this repo uses. `.filter` on a Promise throws, the handler catch swallows it, and
the user gets "⚠️ Something went wrong handling that command." **`/queue` never
worked, for any guild, at any queue length.**

```
typeof res: object | isPromise: true
filter THROWS: TypeError: res.filter is not a function
awaited filter: 1
```

This materially supports the premise of the migration: if `/queue` was dead, the
web was the only working way to see a queue.

## Evidence log

| Commit | Task | Evidence |
|---|---|---|
| `9229752` | A1 | Branch created. |
| `d06ca59` | A2 | `lib/queue.ts` + 18 tests. RED `Cannot find module './queue'` → GREEN 18/18. |
| `14625d6` | A3 | `lib/components.ts` + 10 tests. RED → GREEN 10/10. |
| `1ba7623` | A4 | `lib/search.ts`, `lib/ytdlp.ts` + 8 tests; `index.ts` −86/+4; spawn block moved verbatim per `git diff`. |
| `c86639a` | A5 | `lib/lyrics.ts` + 6 tests. |
| `6cd1d83` | A6 | `/search` + picker; `queueTrackForGuild()` at index.ts:1603 (pre-C). |
| `8fd6204` | A7 | `/queue` panel; `loadQueue()`, `queuePanel()`. |
| `bc89ff3` | A2/A7 | Corrected the `/queue` defect with empirical proof. |
| `e2291f4` | A8 | Card; `currentSongForRoom()`, `skipVoteCount()`, `markSkipped()`, `publishNowPlaying()`. |
| `a07f6b4` | A9–A12 | `/lyrics`, `/admin`, `/help`; `adminView()`; gate exemption for admins. |
| `d1f61e6` | A2–A12 | Slice A docs + the A13 checklist. |
| `cae0312` | C2, C3 | index.ts −940 lines; `/health`, `/ready`, `/metrics` only; JWT tests removed. |
| `df05281` | C3 gap | Playlist parity restored in the bot; `songs.id` ordering tiebreaker. |
| `2f53e0a` | B1–B4 | Room maps deleted; voice-only presence; Idle guard restored; `purgeUnreachableRooms()`. |
| `8842019` | C1 | `packages/web` deleted; lockfile 362→209 packages. |
| `227cc85` | C4 | Dockerfile web stage removed; compose env trimmed. |
| `7afd200` | C5 | Migration 0010; fresh-DB and populated-table checks against real libSQL. |
| `c61c26b` | C6 | README rewritten; invite permissions documented. |
| `618f7dc` | deps | Removed `@noble/ciphers` (JWT-only), `@hono/node-server` and `nanoid` (unused), `prism-media` (already a `@discordjs/voice` dependency): 209→206 packages. Re-ran the boot smoke afterwards to prove the voice stack still resolves. |
