import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { createClient } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema";

// The DB file must live inside the mounted volume so it survives redeploys.
// docker-compose sets DATABASE_URL=file:/app/data/data.db (the volume mount);
// the default keeps dev/standalone runs persistent too instead of writing to a
// throwaway path.
const url = process.env.DATABASE_URL ?? "file:./data/data.db";

// libSQL won't create the parent directory of a local file: URL, so ensure it
// exists before opening the connection. Remote/in-memory URLs are left as-is.
if (url.startsWith("file:")) {
  mkdirSync(dirname(url.slice("file:".length)), { recursive: true });
}

const client = createClient({ url });

// Pragmas for the local file DB: retry instead of erroring on a busy writer,
// enforce the schema's foreign keys, and use WAL for read/write concurrency.
await client.execute("PRAGMA busy_timeout = 5000;");
await client.execute("PRAGMA foreign_keys = ON;");
await client.execute("PRAGMA journal_mode = WAL;");
await client.execute("PRAGMA synchronous = NORMAL;");

export const db = drizzle(client, { schema });

// Apply the versioned migrations in ./drizzle at startup, against the volume DB.
// This replaces the build-time `drizzle-kit push` (which baked the schema into
// the image and never reached the persistent volume). Resolved relative to this
// module so it works regardless of the process cwd.
await migrate(db, {
  migrationsFolder: new URL("../../drizzle", import.meta.url).pathname,
});
