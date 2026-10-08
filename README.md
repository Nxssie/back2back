# Back2Back 🎵

Synchronized music playback with your friends, driven entirely from Discord. A
guild is a room: a vote-ordered queue, search from inside Discord, lyrics, and a
bot that joins voice chat to play it back. There is no web app — every action is
a slash command or a button.

## Features

- **Vote-ordered queue** — the highest-voted unplayed track plays next; ties break by insertion order.
- **YouTube, SoundCloud, Mixcloud & Twitch** — single tracks, YouTube playlists, and SoundCloud sets.
- **Search in Discord** — `/search` lists results as a select menu, no links to copy.
- **Interactive queue panel** — `/queue` pages through the queue with upvote and remove controls.
- **Now-playing card** — one message per guild, updated per track, with vote-skip and playlist controls.
- **Vote-to-skip** — threshold based on who is actually listening in the voice channel; the song's adder skips free.
- **Lyrics** — `/lyrics` fetches the current track's lyrics.
- **Server moderation** — `/admin` approves or rejects servers; admins can act on any queue.
- **Hardened by default** — adversarial input validated at the boundary, hourly GC of stale rooms and old played songs, /metrics fails closed, graceful shutdown.

## Tech Stack

- **Runtime**: Bun
- **Backend**: Hono (health/readiness/metrics only) + Discord gateway client
- **Database**: SQLite (libSQL) + Drizzle ORM
- **Audio**: yt-dlp + ffmpeg + @discordjs/voice
- **Bot**: Discord.js

## Architecture

```
┌────────────────────────┐     ┌─────────────┐
│  Server (Bun)          │────▶│   yt-dlp    │
│  Discord bot + queue   │     │  (Audio)    │
│  /health /ready        │     └─────────────┘
└────────────────────────┘            │
              │                       ▼
              ▼                 ┌─────────────┐
       ┌─────────────┐          │   ffmpeg    │
       │   Discord   │◀─────────│  (Opus)     │
       └─────────────┘          └─────────────┘
```

The HTTP surface is an operational side channel only. Playback, the queue, and
every user-facing action happen over the Discord gateway.

## Development

### Requirements
- Bun
- yt-dlp on `$PATH` (audio extraction)
- A Discord application with a bot token (see *Discord application setup*)

### Setup

```bash
git clone git@github.com:Nxssie/back2back.git
cd back2back
bun install

cp .env.example .env
# Edit .env: DISCORD_TOKEN is the only required value

./dev.sh
```

The database file is created and migrated on first boot — `src/db/index.ts`
applies everything in `packages/server/drizzle` at startup, so a deploy never
needs a separate migration step. After changing `src/db/schema.ts`, generate a
migration and commit it alongside the schema:

```bash
bun db:generate
```

### Running

**Option 1: Docker (recommended for production)**
```bash
docker compose up
```

**Option 2: Local development**

Install yt-dlp once:
```bash
pip install yt-dlp
```

The convenience script loads `.env` into the server and gives the process its own
process group for clean Ctrl+C shutdown:
```bash
./dev.sh
```

Or directly:
```bash
bun dev:server   # http://localhost:3001
```

### Configuration

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_TOKEN` | yes | bot token; without it the bot does not start |
| `DISCORD_CLIENT_ID` | for `db:deploy:commands` | application id |
| `ADMIN_DISCORD_IDS` | no | comma-separated Discord user IDs allowed to use `/admin` |
| `METRICS_TOKEN` | no | bearer token for `GET /metrics`; **unset disables the endpoint** |
| `ROOM_TTL_HOURS` | no | default `24`; empty idle rooms are removed after this |
| `PLAYED_SONG_TTL_HOURS` | no | default `24`; played songs and their votes are purged after this |
| `EMPTY_QUEUE_LEAVE_MINUTES` | no | default `5`; the bot leaves a voice channel after this long with an empty queue |
| `DATABASE_URL` | no | default `file:./data/data.db` |
| `PORT` | no | default `3001` |
| `YTDLP_COOKIES`, `YTDLP_EXTRACTOR_ARGS`, `YTDLP_DOWNLOADER` | no | yt-dlp hardening for hosts YouTube rate-limits |

## Commands

| Command | What it does |
|---|---|
| `/play <url>` | Queue a track, playlist, or set and start playing |
| `/search <query> [source]` | Search YouTube, SoundCloud, or Twitch, then pick from a select menu |
| `/queue` | Paginated queue panel with upvote and remove controls |
| `/lyrics` | Lyrics for the track currently playing |
| `/listen` | Join your voice channel and start the queue |
| `/skip` | Skip the current song (adder free; otherwise needs votes) |
| `/stop` | Stop playback and disconnect (Manage Server) |
| `/reset` | Mark every song playable again (Manage Server) |
| `/room` | Which queue this server is playing and whether the bot is connected |
| `/admin` | Approve or reject servers waiting for access (admins only) |
| `/help` | List the available commands |

The now-playing card carries the per-track controls: **Vote skip**, **Skip**, and
— for playlist tracks — **Skip playlist**, which marks the rest of that playlist
played.

Buttons and select menus carry their whole payload in the component id, so they
keep working across bot restarts and stale messages left in a channel.

### Server endpoints

- `GET /health` — liveness
- `GET /ready` — readiness (database + Discord gateway)
- `GET /metrics` — operational metrics; requires `Authorization: Bearer $METRICS_TOKEN`, 403 when unset

## Discord application setup

Create the app in the Discord Developer Portal, then invite it with the
permissions the bot actually needs. **`Embed Links` is required** — the queue
panel and now-playing card are embeds, and Discord rejects them without it:

```
https://discord.com/oauth2/authorize?client_id=<DISCORD_CLIENT_ID>&scope=bot%20applications.commands&permissions=36719616
```

| Permission | Bit | Why |
|---|---|---|
| View Channels | 1024 | read the guild |
| Send Messages | 2048 | post the panel and confirmations |
| Embed Links | 16384 | **required** for the panel and now-playing card |
| Connect | 1048576 | join a voice channel |
| Speak | 2097152 | play audio |
| Use Voice Activity | 33554432 | voice playback |

Slash commands are registered on every boot, so a redeploy picks up changes. To
register them without starting the bot: `bun --filter server deploy:commands`.

Newly invited servers start **pending** and cannot use commands until an admin
approves them with `/admin`. Admins are exempt from that gate so a server can be
bootstrapped.

## Deploy (Coolify + Cloudflare Tunnel)

Deployed as a **Docker Compose** resource in Coolify, with a **Cloudflare Tunnel**
terminating TLS at the edge (no public ports open on the host). Coolify's Traefik
only serves HTTP and routes by `Host`; it must **not** request a Let's Encrypt
certificate. The compose declares no Traefik labels and no custom networks on
purpose — Coolify generates the router and the per-stack network from the UI
domain. Do not re-add them.

### 1. Create the resource

In Coolify: **+ New → Docker Compose**, point it at this repo / `docker-compose.yml`.
The domain goes on the **`server`** service.

### 2. Environment variables

Coolify auto-detects the `${VAR}` placeholders from the compose and lists them:

| Variable | Value | Notes |
|---|---|---|
| `DISCORD_TOKEN` | bot token | mark **Is Secret?** |
| `DISCORD_CLIENT_ID` | application id | |
| `ADMIN_DISCORD_IDS` | comma-separated ids | optional |
| `METRICS_TOKEN` | `openssl rand -hex 32` | optional; unset disables `/metrics` |
| `ROOM_TTL_HOURS` | `24` | optional |

### 3. Ingress: Coolify domain as HTTP, TLS via Cloudflare

- Coolify → `server` service → **Domains**: `http://b2b.nxssie.dev` (**`http://`**, not
  `https://`). This stops Traefik from requesting a Let's Encrypt cert and from
  adding an http→https redirect (which would loop behind Cloudflare).
- Cloudflare Zero Trust → Networks → Tunnels → your tunnel → **Public Hostname**
  for `b2b.nxssie.dev` → Service `HTTP` → `http://localhost:80` (Traefik /
  coolify-proxy on the host; use the host LAN IP if `cloudflared` runs elsewhere).
  Leave the HTTP Host Header empty so the original host is preserved for Traefik.
- Cloudflare → SSL/TLS → **Full**.

Traefik forwards every path, so `/metrics` is reachable from the public domain. It
fails closed without `METRICS_TOKEN`; set one, or block the path at the edge.

### 4. Invite the bot

```bash
curl -s https://b2b.nxssie.dev/ready     # {"ok":true,"discord":true}
```

Invite the bot with the URL from *Discord application setup* above, then run
`/help` in the server. A server that has never been approved answers with the
pending-approval message; approve it from `/admin` as an admin.

## Not carried over from the web version

Deliberate, documented losses from removing the SPA — not regressions to fix
silently:

- **Synchronised lyrics.** The web panel highlighted the current line against
  playback. Discord has no equivalent without repeatedly editing a message, so
  `/lyrics` posts the text once.
- **The visual identity.** The waveform, glyphs, reticle corners, and the custom
  CSS theme were part of the web app.
- **Playlist grouping in the queue view.** Playlists are queued and skippable as a
  unit, but the queue panel lists tracks in play order rather than nesting them
  under their playlist.
- **Public metrics.** `/metrics` used to be readable by any logged-in admin;
  it now requires a bearer token, because the session layer is gone.

## VPS Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| **CPU** | 1 core | 2 cores |
| **RAM** | 1 GB | 2 GB |
| **Storage** | 5 GB SSD | 10 GB SSD |
| **Bandwidth** | 500 GB/month | 1 TB/month |

The container runs under 768 MB in steady state. Add a **swap file** on
RAM-constrained VPS to absorb transient yt-dlp/ffmpeg spikes:

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Providers that fit: Hetzner CX22 (2 vCPU, 4 GB, ~€6/month), Contabo VPS S
(4 vCPU, 4 GB, ~€5/month).
