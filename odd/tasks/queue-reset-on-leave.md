# Feature: reliable /play and a session-scoped queue

`/play <url>` must never be lost to an expired interaction, and when the bot
leaves the voice channel the pending queue must be cleared so the next session
starts from zero.

## Status

| Field | Value |
|---|---|
| State | **Code complete** — checks green; independent verification unavailable (the verifier returned no report) |
| Branch | `fix/queue-reset-on-leave` (from `main` at `302542e`) |
| Slices | queue helper → ack policy → wiring → docs; 520 authored lines over 4 commits, so the review unit is the whole branch, not one commit |
| Tasks | 8 |
| Blocked on the user | push / PR decision (the branch is local, not pushed) |

## Decisions locked

| Decision | Choice |
|---|---|
| What "clear" deletes | only `played = false` rows of the room, plus their votes |
| Played history | kept (feeds `/room` counters and `PLAYED_SONG_TTL_HOURS`) |
| Leave paths that clear | automatic reap, failed voice reconnect, `/stop`, guild removed/rejected, shutdown |
| Acknowledgment | one `deferReply` at the top of `InteractionCreate`, before any await |
| Ephemeral style | decided per command in `lib/ack.ts`, not per branch |
| Feedback | `/play` distinguishes "queued and playing" from "queued, did not start"; `/stop` reports the cleared count |

## Specs

- **S1** — the user's rule, verbatim: «a veces falla al darle /play con url».
  A `/play <url>` invocation must always be acknowledged and answered, however
  slow the database write, the yt-dlp resolution or the playlist insert is.
- **S2** — the observed failure, verbatim: «No responde y el log pone "Unknown
  interaction"». Every slash command is deferred before the first awaited work,
  so no database read, upsert, yt-dlp call or playlist insert can run inside
  Discord's three-second acknowledgment window. Every registered command has a
  defer-time reply policy (ephemeral or public) and every slash branch answers
  through `editReply`; a command added later without a policy is reported.
- **S3** — the user's rule, verbatim: «si el bot deja el canal de discord su
  cola persiste, debería limpiarse para que en la siguiente vez parta de 0».
- **S4** — "limpiarse" deletes only the room's pending songs (`played = false`)
  and the votes attached to them. Played history stays (it feeds `/room`
  counters and the played-song TTL) and another room's rows are never touched.
- **S5** — leave paths that clear the queue: the automatic reaper (alone in
  channel, empty queue), a failed voice reconnect, `/stop`, guild removal, and
  process shutdown. Leaving is idempotent: an already-empty queue is a no-op.
- **S6** — a leave cannot race a `/play`: the reaper skips a guild while a
  play request or an advance is in flight, and a stale `Disconnected` handler
  may not tear down a newer connection registered for the same guild.
- **S7** — `/play` reports the difference between "queued and playing" and
  "queued but playback did not start" instead of always claiming success.
- **S8** — `README.md` documents the session-scoped queue and the new `/stop`
  effect.
- **S9** — checks: `bun test` and the server build, plus the committed tests
  for the queue clearing and the acknowledgment policy. No live Discord smoke
  (there is no harness for it in this repo).

## Tasks

- [x] **T1** — Acknowledgment policy: `src/lib/ack.ts` + `ack.test.ts` (S2, S9). `0d2e177`
- [x] **T2** — Defer every slash command up front; convert slash branches to
      `editReply`; gate and catch paths handle both interaction kinds (S1, S2). `e7bee73`
- [x] **T3** — `src/lib/pendingQueue.ts` + `pendingQueue.test.ts` (S4, S9). `8ec9727`
- [x] **T4** — `leaveVoice()` on every leave path, including shutdown; `/stop`
      reports the cleared count (S3, S4, S5). `e7bee73`
- [x] **T5** — Reaper/play race guards, stale-connection replacement, stale
      `Disconnected` handler ownership, `/play` playback feedback (S6, S7). `e7bee73`
- [x] **T6** — `README.md` update (S8)
- [x] **T7** — Checks and evidence (S9)
- [x] **T8** — Review fixes (S2, S5, S6), route: direct inline (2 files, cause
      already mapped by the review): a stale connection no longer clears the
      songs `/play` just inserted (`endStaleSession` runs before the insert;
      `connectToVoiceChannel` only tears down); `ephemeralNotice` deletes the
      public "thinking…" placeholder before its ephemeral follow-up (or edits an
      already-private defer); `/skip`'s empty answer edits its ephemeral defer.

## Evidence

| Check | Result |
|---|---|
| `bun test` | 67 pass, 0 fail (8 files); the 7 new cases are `ack.test.ts` (4) and `pendingQueue.test.ts` (3) |
| `bun build src/index.ts --target bun` | bundled 741 modules, exit 0 |
| Differential vs `302542e` | server booted on both trees without a token against fresh databases: `/health`, `/ready`, `/metrics` (200 with token, 403 without) and `/nope` (404) identical, and stdout identical after stripping timestamps |
| Database rules | `pendingQueue.test.ts` runs the real `drizzle/` migrations on a temp file database (a `:memory:` database cannot serve drizzle's transaction, which opens its own connection) |
| Slice boundary | After `36d7d54` the branch is past the ~400 authored-line review slice (520). Review it as one unit; any follow-up work goes on top, not inside these commits. |
| T8 `bun test` | 71 pass, 0 fail (8 files); +3 `ephemeralNotice` cases in `ack.test.ts` |
| T8 build / types | `bun build` exit 0; ad-hoc `tsc --strict` on `index.ts` reports only the 3 pre-existing errors (`bun` module types, `member.voice` at the two voice gates) |
| Independent verification | **Unavailable** — `gentle-ai-verify` was launched on `e7bee73` and returned no final report. Not retried: an unavailable verifier is reported, not escalated. The remaining outside view is the user's review or a new verification run. |

## Known residue

- **The independent review did not happen.** The delegated verifier failed
  without a report, so the high-risk read of the interaction and leave wiring
  rests on inspection, `bun test`, the build and the differential boot. This is
  the one piece of the plan that is missing, and it is the reason to look at
  `e7bee73` closely before pushing.
- No automated test imports `index.ts` (there is no interaction harness), so the
  acknowledgment order, the leave wiring and the race guards rest on the build,
  the differential boot and inspection. `lib/ack`'s test at least pins the
  "every command has a policy" rule.
- In a server that is still pending approval, a public-reply command (`/play`,
  `/listen`, `/queue`, ...) now shows the "pending admin approval" notice
  publicly instead of ephemerally, because the reply style is fixed at defer
  time. Acceptable: the bot is dormant there.
- `/reset` revives played history into pending songs; if the bot then leaves the
  channel, that revived queue is cleared like any other pending queue. This
  follows S3/S4 and the README now scopes `/reset` to the current session.

## Log

- **L1** — «hay un problema actualmente, a veces falla al darle /play con url y
  si el bot deja el canal de discord su cola persiste, debería limpiarse para
  que en la siguiente vez parta de 0»
- **L2** — Clarification on the failure: no responde y el log pone «Unknown
  interaction».
- **L3** — Clarification on the cleanup: borrar solo las canciones pendientes
  (`played=false`).
- **L4** — Clarification on scope: salida automática (solo en canal / cola
  vacía), caída de la conexión de voz y `/stop`.
