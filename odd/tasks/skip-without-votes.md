# Feature: single-person skip, no vote gate

Any single listener can skip the current song — and the rest of a playlist —
whether or not they added it to the queue.

## Status

| Field | Value |
|---|---|
| State | **Done** — code complete, verified and committed on `main` |
| Branch | `main` (user asked for the change directly on this branch) |
| Commit | `03720a8` — behavior, migration and README |
| Slices | schema → bot surface → dead code → docs |
| Tasks | 5 |
| Blocked on the user | push decision |

## Decisions locked

| Decision | Choice |
|---|---|
| Vote machinery | **Removed entirely** — `Vote skip` button, `skip_votes` table, `skipThreshold`, `voting.ts` |
| `/skip` | Unconditional for any member in the guild |
| Now-playing **Skip** button | Unconditional; the **Vote skip** button disappears |
| **Skip playlist** button | Gate removed: no adder-or-admin check, any member may run it |
| Playlist *remove* / queue **Remove** button | **Untouched** — still adder-or-admin |

## Why

The vote gate existed to stop one member from killing a song the room wanted. On a
Discord bot used by small friend groups, that cost more than it saved: presence-based
thresholds are invisible, the "Vote skip" and "Skip" buttons read as near-duplicates,
and the adder's free pass made the rule feel arbitrary.

## Tasks

- [x] **S1** Drop `skip_votes` from the Drizzle schema and generate migration `0011`.
- [x] **S2** Make skipping unconditional: now-playing **Skip**, `/skip`, and
      **Skip playlist**; delete the `p_skipvote` handler, `skipVoteCount`, and every
      `skipVotes` delete (Idle advance, `markSkipped`, queue remove, playlist skip, GC).
- [x] **S3** Delete `src/lib/voting.ts` + its test, and the then-dead `roomPresence`
      / `voicePresenceByRoom` helpers.
- [x] **S4** Update `README.md` (features, commands table, card controls).
- [x] **S5** Checks: `bun test` and the server build.

## Evidence

| Commit | Task | Note |
|---|---|---|
| `03720a8` | S1–S4 | Migration generated as `0011_rapid_loners.sql` (drizzle-kit, journal + snapshot). `bun test`: 62 → 60 pass, 0 fail (the 2 deleted `voting.test.ts` cases). Server build clean. Independent verification (gentle-ai-verify): all 7 items pass. |
| `03720a8` | S5 | Fresh-DB migration smoke: 12 migrations apply, user tables end as `guilds, rooms, songs, users, votes` — `skip_votes` gone. |

## Known residue

- Cards posted before the deploy still render a **Vote skip** button; its `p_skipvote`
  custom id now matches no handler, so the click is a silent no-op until the card is
  replaced on the next track.
- No automated test imports `index.ts` (no interaction harness), so the skip paths rest
  on the build plus inspection, not on an executed test.
