import { sqliteTable, text, integer, unique, index } from "drizzle-orm/sqlite-core";
import { desc } from "drizzle-orm";

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
  // Source-native track id: YouTube's 11-char id, or SoundCloud's numeric id.
  videoId: text("video_id").notNull(),
  source: text("source").notNull().default("youtube"), // "youtube" | "soundcloud"
  url: text("url").notNull(),
  title: text("title"),
  uploader: text("uploader"),
  // Artwork URL — only set for sources (SoundCloud) with no derivable thumbnail
  // CDN pattern. YouTube thumbnails are derived client-side from videoId.
  thumbnail: text("thumbnail"),
  addedBy: text("added_by"),
  addedByUserId: text("added_by_user_id"),
  votes: integer("votes").default(0),
  played: integer("played", { mode: "boolean" }).default(false),
  playlistId: text("playlist_id"),
  playlistTitle: text("playlist_title"),
  createdAt: integer("created_at").$defaultFn(() => Math.floor(Date.now() / 1000)),
}, (t) => [
  // Hot path: WHERE room_id = ? ORDER BY votes DESC, created_at (the /songs poll,
  // auto-advance, and the queue command). DESC on votes is required, or SQLite
  // still builds a temp b-tree for the ORDER BY.
  index("songs_room_votes_created_idx").on(t.roomId, desc(t.votes), t.createdAt),
  // skip / next / playlist-skip filter by room + played.
  index("songs_room_played_idx").on(t.roomId, t.played),
]);

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
  (t) => [
    unique().on(t.songId, t.userId),
    // The /songs poll looks up a user's votes by user_id alone, which the
    // composite unique index (song_id first) can't serve.
    index("votes_user_id_idx").on(t.userId),
  ]
);

// Skip-votes are separate from upvotes so the two intents don't collide:
// an upvote means "I want this to play", a skip-vote means "skip it now".
// Reusing the upvote tally as skip authority (the old model) was inverted —
// a popular song (many upvotes) was *easier* to skip, which is backwards.
export const skipVotes = sqliteTable(
  "skip_votes",
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
  (t) => [
    unique().on(t.songId, t.userId),
  ]
);

export const guilds = sqliteTable("guilds", {
  id: text("id").primaryKey(), // Discord guild ID
  name: text("name"),
  approved: integer("approved", { mode: "boolean" }).notNull().default(false),
  requestedBy: text("requested_by"),
  requestedByUsername: text("requested_by_username"),
  requestedAt: integer("requested_at"),
  approvedAt: integer("approved_at"),
});

export type User = typeof users.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type Song = typeof songs.$inferSelect;
export type Vote = typeof votes.$inferSelect;
export type GuildRecord = typeof guilds.$inferSelect;
export type SkipVote = typeof skipVotes.$inferSelect;
