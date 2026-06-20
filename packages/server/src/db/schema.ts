import { sqliteTable, text, integer, unique } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // Discord user ID
  username: text("username").notNull(),
  avatar: text("avatar"),
  // Bumped on logout to invalidate all previously-issued JWTs for this user.
  tokenVersion: integer("token_version").notNull().default(0),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)),
});

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  name: text("name"),
  createdBy: text("created_by"), // Discord user id of the room owner
  lastActivityAt: integer("last_activity_at").$defaultFn(() => Math.floor(Date.now() / 1000)),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)),
});

export const songs = sqliteTable("songs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id),
  videoId: text("video_id").notNull(),
  url: text("url").notNull(),
  title: text("title"),
  uploader: text("uploader"),
  addedBy: text("added_by"),
  addedByUserId: text("added_by_user_id"),
  votes: integer("votes").default(0),
  played: integer("played", { mode: "boolean" }).default(false),
  playlistId: text("playlist_id"),
  playlistTitle: text("playlist_title"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)),
});

export const votes = sqliteTable(
  "votes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    songId: integer("song_id")
      .notNull()
      .references(() => songs.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)),
  },
  (t) => [unique().on(t.songId, t.userId)]
);

export type User = typeof users.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type Song = typeof songs.$inferSelect;
export type Vote = typeof votes.$inferSelect;
