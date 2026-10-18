import { test, expect, afterEach } from "bun:test";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../db/schema";
import { songs, votes } from "../db/schema";
import { clearPendingQueue } from "./pendingQueue";

// A throwaway database file carrying the real migrations, so the rule runs
// against the schema that ships instead of a hand-written copy. A file (not
// `:memory:`) because drizzle's libSQL transaction opens its own connection,
// and a `:memory:` database does not exist on a second connection.
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "back2back-test-"));
  const client = createClient({ url: `file:${join(dir, "test.db")}` });
  cleanups.push(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const database = drizzle(client, { schema });
  await migrate(database, {
    migrationsFolder: new URL("../../drizzle", import.meta.url).pathname,
  });
  return database;
}

type Database = Awaited<ReturnType<typeof freshDb>>;

async function seed(database: Database) {
  await database.insert(schema.rooms).values([{ id: "g1" }, { id: "g2" }]);
  await database.insert(schema.users).values([{ id: "u1", username: "listener" }]);
  const inserted = await database
    .insert(schema.songs)
    .values([
      { roomId: "g1", videoId: "pending-a", url: "https://example.com/a", played: false },
      { roomId: "g1", videoId: "pending-b", url: "https://example.com/b", played: false },
      { roomId: "g1", videoId: "played-c", url: "https://example.com/c", played: true },
      { roomId: "g2", videoId: "other-room", url: "https://example.com/d", played: false },
    ])
    .returning({ id: schema.songs.id, videoId: schema.songs.videoId });
  const idOf = (videoId: string) => inserted.find((s) => s.videoId === videoId)!.id;
  await database.insert(schema.votes).values([
    { songId: idOf("pending-a"), userId: "u1" },
    { songId: idOf("played-c"), userId: "u1" },
    { songId: idOf("other-room"), userId: "u1" },
  ]);
  return { pendingA: idOf("pending-a"), pendingB: idOf("pending-b"), playedC: idOf("played-c") };
}

test("clearPendingQueue deletes pending songs and their votes, keeping history and other rooms", async () => {
  const database = await freshDb();
  const ids = await seed(database);

  const cleared = await clearPendingQueue(database, "g1");

  expect(cleared).toBe(2);
  const remaining = await database.select().from(songs).all();
  expect(remaining.map((s) => s.videoId).sort()).toEqual(["other-room", "played-c"]);
  const votesLeft = await database.select().from(votes).all();
  const remainingIds = new Set(remaining.map((s) => s.id));
  // Every surviving vote belongs to a surviving song; the pending song's vote
  // and its row went together.
  expect(votesLeft.every((v) => remainingIds.has(v.songId))).toBe(true);
  expect(votesLeft.some((v) => v.songId === ids.playedC)).toBe(true);
  expect(votesLeft.some((v) => v.songId === ids.pendingA)).toBe(false);
});

test("clearPendingQueue keeps a played row's history intact", async () => {
  const database = await freshDb();
  const ids = await seed(database);

  await clearPendingQueue(database, "g1");

  const kept = (await database.select().from(songs).all()).find((s) => s.id === ids.playedC)!;
  expect(kept.played).toBe(true);
  expect(kept.videoId).toBe("played-c");
});

test("clearPendingQueue is a no-op on an already empty queue", async () => {
  const database = await freshDb();
  await seed(database);
  await clearPendingQueue(database, "g1");

  expect(await clearPendingQueue(database, "g1")).toBe(0);
  expect(await clearPendingQueue(database, "unknown-room")).toBe(0);

  const otherRoom = (await database.select().from(songs).all()).find(
    (s) => s.roomId === "g2"
  );
  expect(otherRoom?.videoId).toBe("other-room");
});
