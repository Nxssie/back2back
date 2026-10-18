// Clearing a room's pending queue. The queue is session-scoped: when the bot
// leaves a voice channel, whatever was still waiting belongs to a session that
// ended, and the next /play must start from zero instead of replaying tracks
// nobody is waiting for any more.
//
// Played rows stay: they feed the /room counters and the played-song TTL. Only
// `played = false` rows go, together with the votes attached to them, because
// `votes.song_id` has a foreign key to `songs.id` and foreign keys are enforced
// (db/index.ts sets `PRAGMA foreign_keys = ON`).

import { and, eq, inArray } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type * as schema from "../db/schema";
import { songs, votes } from "../db/schema";

type Database = LibSQLDatabase<typeof schema>;

// Deletes the room's pending songs and their votes in one transaction, and
// returns how many songs went. Idempotent: an empty queue deletes nothing and
// returns 0, and rows of any other room are never touched.
export async function clearPendingQueue(database: Database, roomId: string): Promise<number> {
  const pending = await database
    .select({ id: songs.id })
    .from(songs)
    .where(and(eq(songs.roomId, roomId), eq(songs.played, false)))
    .all();

  if (pending.length === 0) return 0;

  const ids = pending.map((song) => song.id);
  await database.transaction(async (tx) => {
    await tx.delete(votes).where(inArray(votes.songId, ids));
    await tx.delete(songs).where(inArray(songs.id, ids));
  });

  return ids.length;
}
