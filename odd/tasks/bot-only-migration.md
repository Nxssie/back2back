# Feature: bot-only migration

Remove the web SPA and make the Discord bot the sole interface, with full
feature parity via slash commands and message components.

## Status

| Field | Value |
|---|---|
| State | in progress — Slice A, 7 of 13 tasks done |
| Branch | `feat/bot-only-migration` |
| Slices | A (additive bot surface) → B (room semantics) → C (delete web + auth) |
| Tasks | 20 |
| Blocked on | Slice A13 needs a live Discord app to smoke-test; Slice C must not start before it passes |

## Decisions locked

| Decision | Choice |
|---|---|
| Scope | Full removal of `packages/web` + the OAuth/JWT layer |
| Search UX | `/search <query>` → ephemeral select menu (25 results). Robust over fast; no autocomplete. |
| Room identity | `roomId == guildId` |
| Lyrics | `/lyrics` plain text, ephemeral, 2000-char safe. **Synced/karaoke playback is dropped.** |
| Presence | Voice-channel membership only |
| HTTP server | Kept, reduced to `/health`, `/ready`, `/metrics` |
| Commits | Only on explicit user request (user's `AGENTS.md` overrides ODD's per-task commit rule) |

## Command surface (target)

| Command | Interaction | Replaces |
|---|---|---|
| `/play <url>` | existing, unchanged | `/api/rooms/:id/songs` |
| `/search <query> [source]` | ephemeral select menu → queue | in-app search |
| `/queue` | embed + prev/next/refresh buttons + upvote select + remove-mine select | queue page |
| `/lyrics` | ephemeral plain text for the current track | lyrics panel |
| `/skip` | unchanged (vote-gated) | skip button |
| `/listen`, `/stop`, `/reset`, `/room` | unchanged | connect / stop / reset |
| `/admin` | ephemeral embed + approve/reject buttons | `/admin` panel |
| `/help` | ephemeral command index | site discoverability |
| now-playing message | edited per track; skip-vote / skip / force-skip buttons | now-playing card |

## Non-goals

- No new features. Parity only.
- No autocomplete search.
- No karaoke-synced lyrics.
- No changes to audio extraction, playback, or the vote/skip algorithms.
- No Discord-E2E test harness (see Risks).

## Slices

Slices exist so the repo works after every commit and the web can be verified
against the new code before anything is deleted.

### Slice A — additive bot surface (web untouched)

Everything here is new code plus extraction of existing HTTP logic into shared,
testable modules. Nothing breaks if Slice A lands alone.

- [x] **A1. Branch + lockfile** — create `feat/bot-only-migration`. `9229752`
- [x] **A2. `lib/queue.ts` (test-first)** — pure queue read-model: page slicing,
       pagination math, embed assembly, 2000-char-safe truncation.
       Fixes the existing `/queue` overflow defect (see Correction below). `d06ca59`
- [x] **A3. `lib/components.ts` (test-first)** — stateless customId codec
       (`b2b:<action>:<payload>`, ≤100 chars, round-trip tests). Survives restarts. `14625d6`
- [x] **A4. `lib/search.ts`** — extract the yt-dlp search spawn out of
       `GET /api/search` into a shared function; add result→choice mapping tests
       (25 cap, 100-char labels, dedupe). HTTP route delegates to it. `1ba7623`
- [x] **A5. `lib/lyrics.ts`** — move `web/src/lib/lyrics.ts` to the server,
       add tests + truncation helper. `c86639a`
- [x] **A6. `/search`** — deferReply(ephemeral) → select menu → queue the pick. `6cd1d83`
- [x] **A7. `/queue` panel** — embed + pagination buttons + upvote select +
       remove-mine select, handled in `InteractionCreate` (no collectors). `8fd6204`
- [ ] **A8. Now-playing message** — post/edit per track in the bound channel,
       with skip-vote / skip / force-skip buttons.
- [ ] **A9. `/lyrics`** — ephemeral plain text for the current track.
- [ ] **A10. `/admin`** — pending-guild list with approve/reject buttons, room
       and voice counts. **Exempt `ADMIN_DISCORD_IDS` from the approval gate**
       (index.ts:1679) so a new guild can be bootstrapped.
- [ ] **A11. `/help`** — ephemeral command index.
- [ ] **A12. Register all new commands** in `commands.ts` + `deploy-commands.ts`.
       (`deploy-commands.ts` consumes the exported array, so only `commands.ts` changes.)
- [ ] **A13. Smoke pass** — verify A6–A11 against live Discord with the web still
       running, so both UIs can be compared. **Requires a live bot; blocked on the user.**

### Slice B — room semantics = guild

- [ ] **B1. Drop `guildRoomMap` / `userCurrentRoom`** fallbacks; `roomId` is
       `guildId` everywhere; `ensureRoom(guildId, userId)`.
- [ ] **B2. `roomPresence()` = voice members only** (index.ts:2041); delete web
       presence. Fixes the inflated skip-threshold denominator.
- [ ] **B3. Simplify empty-room GC** and `/room`'s default-room branch.
- [ ] **B4. Data decision** — orphan the existing nanoid rooms (GC reaps them)
       or write a one-off mapping. No schema change either way. Decide with user.
- [ ] **B5. `/room`** — repurpose or remove once room == guild.

### Slice C — delete web + auth

Only after Slice A is verified live.

- [ ] **C1. Delete `packages/web/`** and its root scripts (`dev:web`, web filter).
- [ ] **C2. Delete auth**: `/auth/discord*`, `/api/auth/me`, `/auth/logout`,
       `lib/jwt.ts` + `jwt.test.ts`, `getUser` (20 call sites), cookie/CORS/state
       handling, SPA fallback (index.ts:1614), static serving.
- [ ] **C3. Delete now-dead HTTP routes**: `/api/rooms/*`, `/api/user/room`,
       `/api/search`, `/api/admin/*`, `/api/bot/invite`. Keep health/ready/metrics.
- [ ] **C4. Env + deploy**: drop `FRONTEND_URL`, `JWT_SECRET`,
       `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI` from `.env.example`,
       `docker-compose.yml`, Dockerfile (drop the Vite build stage and `tsc`).
- [ ] **C5. DB**: drop `users.token_version` via migration, or leave with a note.
- [ ] **C6. Docs**: README (features, architecture diagram, setup) + CI review.
- [ ] **C7. Final smoke pass** — full manual checklist on a clean deploy.

## Verification

| Layer | How |
|---|---|
| Pure logic (A2–A5, C5) | `bun test` — test-first, RED before GREEN |
| Discord interactions (A6–A11) | Manual smoke checklist, live app per Slice A13 / C7 |
| Deploy (C4) | `docker compose up` on a rebuilt image; `/health` + `/ready` green |
| Regression | `bun install --frozen-lockfile` + full `bun test` (26 tests at baseline) |

No automated Discord E2E exists and none is proposed here — that is the honest
coverage gap, and it is why Slice A must be smoke-tested before Slice C deletes
the fallback UI.

## Risks

| Risk | Mitigation |
|---|---|
| No automated E2E for interactions | Manual checklist per slice; slices ordered so the old UI still exists while the new one is verified |
| Discord hard limits (25 select options, 5 component rows, 100-char id/label, 2000-char message) | Encoded in `lib/queue.ts` + `lib/components.ts` with unit tests |
| `/search` spawns yt-dlp (slow) | `deferReply` first, then edit with the select; 15s timeout already in the route |
| Bot restart loses message ids | Stateless customIds; re-post now-playing on next `/listen` |
| Approval-gate deadlock after web removal | A10 exempts admin IDs from the gate |
| Deleting the web is hard to reverse mid-flight | Slices A→B→C; C only after A13 passes |

## Correction: the `/queue` defect was a crash, not an overflow

This plan originally reported that `/queue` broke past roughly twenty songs
because it joined every unplayed song into one untruncated string.

The real defect was worse. At the pre-migration revision the handler called
`db.select().from(songs)...orderBy(...).all().filter((s) => !s.played)` without
awaiting, and `.all()` returns a **Promise** with the `drizzle-orm/libsql`
driver this repo uses (`packages/server/src/db/index.ts`). `.filter` on a
Promise throws `TypeError: ... .filter is not a function`, the outer handler
catch swallows it, and the user gets "⚠️ Something went wrong handling that
command." **`/queue` never worked, for any guild, at any queue length.**

Verified empirically against the repo's own driver stack:

```
typeof res: object | isPromise: true
filter THROWS: TypeError: res.filter is not a function
awaited filter: 1
```

The truncation issue was therefore not observable — the command never reached
the string join. Both are fixed by A2 and A7: `loadQueue()` awaits, and
`formatQueuePage()` paginates.

This also materially supports the premise of the migration. If `/queue` was
dead, the web was the only working way to see a queue, which is consistent with
users settling on the SPA for everything except `/play`, `/skip`, and `/stop`.

## Open questions

1. Slice B4: migrate existing room rows to guild ids, or let GC drop them?
2. Slice C5: drop `users.token_version` (migration) or keep the column?
3. Admin scope: should `/admin` live in guilds at all, or move to DMs to the admin?

## Evidence log

| Commit | Task | Evidence |
|---|---|---|
| `9229752` | A1 | Branch `feat/bot-only-migration` created from `main`. |
| `d06ca59` | A2 | `lib/queue.ts` + 18 tests. RED: `Cannot find module './queue'`. GREEN: `bun test packages/server/src/lib/queue.test.ts` → 18 pass, 0 fail, 48 expect() calls. |
| `14625d6` | A3 | `lib/components.ts` + 10 tests. RED: `Cannot find module './components'`. GREEN: 10 pass, 0 fail, 25 expect() calls. Full suite 54 pass. |
| `1ba7623` | A4 | `lib/ytdlp.ts`, `lib/search.ts` + 8 tests; `index.ts` −86/+4. RED: module missing, then GREEN 8 pass. Full suite 62 pass. `git diff` confirms the spawn block moved verbatim apart from renames. |
| `c86639a` | A5 | `lib/lyrics.ts` + 6 tests. RED: module missing, then GREEN. Full suite 68 pass. |
| `6cd1d83` | A6 | `/search` + `search_pick` handler; `queueTrackForGuild()` extracted from `/play` (index.ts:1603). Full suite 68 pass. **Live interaction path unverified.** |
| `8fd6204` | A7 | `/queue` panel; `loadQueue()` (index.ts:1657) and `queuePanel()` (index.ts:1669). Full suite 68 pass. **Live interaction path unverified.** |

### Verification gap

Every Slice A interaction path (A6, A7, and A8 onward) is only **structurally
verified**: `bun test` never loads `index.ts`, and the repo has no Discord
interaction harness. No live bot session was available. A13 exists to close this
gap and is a hard gate on Slice C.

The pure logic behind those paths (`lib/queue.ts`, `lib/components.ts`,
`lib/search.ts`, `lib/lyrics.ts`) is test-first covered.
