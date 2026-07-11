# Back2Back 🎵

Synchronized music playback with your friends. Replaces the Discord workflow of
passing links to bots — a shared room with a vote-ordered queue, in-app search,
and a Discord bot that joins voice chat to play it back.

## Features

- **Vote-ordered queue** — the highest-voted unplayed track plays next; ties break by recency.
- **YouTube & SoundCloud** — single tracks, YouTube playlists, SoundCloud sets, and Mixcloud mixes.
- **In-app search** — find tracks on YouTube or SoundCloud without leaving the room.
- **Discord OAuth** — JWT sessions in an http-only cookie, revocable on logout via token versioning.
- **Discord bot** — slash commands to play and control playback from a voice channel.
- **Vote-to-skip** — presence-based threshold; the song's owner skips free.
- **Ownership & moderation** — creators delete their own rooms/songs; admins delete any.
- **Admin panel** — live room list with song, pending, and presence counts, plus `/metrics`.
- **Hardened by default** — rate limiting, input validation, hourly GC of stale rooms and old played songs, graceful shutdown.

## Tech Stack

- **Runtime**: Bun
- **Backend**: Hono (HTTP API + Discord gateway client)
- **Frontend**: React 19 + Vite 6, Tailwind CSS 4, React Router 7
- **Database**: SQLite (libSQL) + Drizzle ORM
- **Audio**: yt-dlp + ffmpeg + @discordjs/voice
- **Bot**: Discord.js

## Architecture

```
┌──────────────────────────┐     ┌─────────────┐
│   Server (Hono + React)  │────▶│   yt-dlp    │
│   API + SPA on :3001     │     │  (Audio)    │
└──────────────────────────┘     └─────────────┘
              │
              ▼
       ┌─────────────┐
       │   Discord   │
       │     Bot     │
       └─────────────┘
```

## Development

### Requirements
- Bun
- yt-dlp on `$PATH` (audio extraction)
- A Discord application: bot token + OAuth2 client id/secret + redirect URI
- Docker (optional, for Compose-based deploy)

### Setup

```bash
# Clone and install dependencies
git clone git@github.com:Nxssie/back2back.git
cd back2back
bun install

# Copy environment variables
cp .env.example .env
# Edit .env with your Discord credentials

# Run database migrations
bun db:generate
bun db:push
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

From the repo root, one command starts both packages:
```bash
bun dev
```

Or use the convenience script, which loads `.env` into the server and gives each
process its own process group for clean Ctrl+C shutdown:
```bash
./dev.sh
```

To run them individually:
```bash
bun dev:server   # http://localhost:3001
bun dev:web      # http://localhost:5173
```

### URLs
- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## API

All `/api/*` routes except `GET /api/rooms/:id` and `GET /api/rooms/:id/songs`
require a valid `b2b_token` session cookie. Mutating routes return `401` when
unauthenticated and `429` when rate-limited.

### Auth
- `GET /auth/discord` — Start the Discord OAuth flow
- `GET /auth/discord/callback` — OAuth callback; sets the session cookie and redirects to `FRONTEND_URL`
- `GET /auth/logout` — Revoke the session (bumps token version) and clear the cookie
- `GET /api/auth/me` — Current user (`{ user }` or `{ user: null }`)

### Rooms
- `GET /api/rooms/:id` — Room info, ownership, and `canDelete`
- `POST /api/user/room` — Set/clear the caller's current room `{ roomId }` (drives presence + skip threshold)
- `DELETE /api/rooms/:id` — Delete a room and cascade its songs/votes (owner or admin)

### Songs
- `GET /api/rooms/:id/songs` — Queue, the caller's votes, presence count, and the currently-streaming song
- `POST /api/rooms/:id/songs` — Add a track or playlist `{ url }` (YouTube, SoundCloud, Mixcloud, or Twitch)
- `DELETE /api/rooms/:id/songs/:songId` — Remove a song (adder or admin)
- `POST /api/rooms/:id/songs/:songId/vote` — Cast a vote (one per user per song)
- `POST /api/rooms/:id/skip` — Skip the streaming song (owner skips free; otherwise votes ≥ threshold)
- `POST /api/rooms/:id/playlists/:playlistId/skip` — Skip the rest of a playlist (adder or admin)

### Playback
- `POST /api/rooms/:id/connect` — Summon the bot into the caller's current voice channel

### Search
- `GET /api/search?q=&n=&source=youtube|soundcloud` — yt-dlp search

### Admin
- `GET /metrics` — Operational metrics (admin only)
- `GET /api/admin/rooms` — All rooms with song/presence counts (admin only)

### Health
- `GET /health` — Liveness
- `GET /ready` — Readiness (DB + Discord gateway)

### Discord Bot

Slash commands (the bot must be invited to the server). `/play` accepts a
YouTube, SoundCloud, Mixcloud, or Twitch URL:

- `/play <url>` — Add a track to the queue and start playing
- `/listen` — Join the caller's voice channel and start the queue
- `/stop` — Stop playback and disconnect
- `/skip` — Skip the current song
- `/queue` — Show the current queue
- `/reset` — Mark all songs as playable again
- `/room` — Show which room this server is currently playing from

## Deploy (Coolify + Cloudflare Tunnel)

Deployed as a **Docker Compose** resource in Coolify, with a **Cloudflare Tunnel**
terminating TLS at the edge (no public ports open on the host). Coolify's Traefik
only serves HTTP and routes by `Host`; it must **not** request a Let's Encrypt
certificate. The compose declares no Traefik labels and no custom networks on
purpose — Coolify generates the router and the per-stack network from the UI
domain. Do not re-add them.

### 1. Create the resource

```bash
git push   # Coolify deploys from the repo
```

In Coolify: **+ New → Docker Compose**, point it at this repo / `docker-compose.yml`.
The domain goes on the **`server`** service — it serves both the API and the
Vite-built frontend (no separate nginx container).

### 2. Environment variables

Coolify auto-detects the `${VAR}` placeholders from the compose and lists them;
just fill in the values:

| Variable | Value | Notes |
|---|---|---|
| `DISCORD_TOKEN` | bot token | mark **Is Secret?** |
| `DISCORD_CLIENT_ID` | application id | |
| `DISCORD_CLIENT_SECRET` | client secret | mark **Is Secret?** |
| `DISCORD_REDIRECT_URI` | `https://b2b.nxssie.dev/auth/discord/callback` | public origin, **https** |
| `FRONTEND_URL` | `https://b2b.nxssie.dev` | public origin, no trailing slash |
| `JWT_SECRET` | `openssl rand -hex 32` | mark **Is Secret?**; server refuses to boot without a strong one |
| `ADMIN_DISCORD_IDS` | comma-separated ids | optional |
| `ROOM_TTL_HOURS` | `24` | optional |

### 3. Ingress: Coolify domain as HTTP, TLS via Cloudflare

- Coolify → `server` service → **Domains**: `http://b2b.nxssie.dev` (**`http://`**, not
  `https://`). This stops Traefik from requesting a Let's Encrypt cert and from
  adding an http→https redirect (which would loop behind Cloudflare).
- Only the *Domains* field is `http://` — `FRONTEND_URL` and `DISCORD_REDIRECT_URI`
  stay **`https://`** (that is the public scheme the browser sees).
- Cloudflare Zero Trust → Networks → Tunnels → your tunnel → **Public Hostname**
  for `b2b.nxssie.dev` → Service `HTTP` → `http://localhost:80` (Traefik /
  coolify-proxy on the host; use the host LAN IP if `cloudflared` runs elsewhere).
  Leave the HTTP Host Header empty so the original host is preserved for Traefik.
- Cloudflare → SSL/TLS → **Full**.

### 4. Discord OAuth

Discord Developer Portal → your app → OAuth2 → Redirects → add **exactly**
`https://b2b.nxssie.dev/auth/discord/callback` (https, no port, no trailing slash).
It must byte-match `DISCORD_REDIRECT_URI`.

### 5. Smoke test

```bash
curl -I https://b2b.nxssie.dev/             # 200, serves the SPA
curl -s https://b2b.nxssie.dev/api/auth/me   # {"user":null}
```

- **502 / 523** → the tunnel can't reach Traefik on `:80` (check the Public Hostname
  service URL).
- **Redirect loop** → the Domains field is still `https://` (must be `http://`).

## VPS Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| **CPU** | 1 core | 2 cores |
| **RAM** | 1 GB | 2 GB |
| **Storage** | 5 GB SSD | 10 GB SSD |
| **Bandwidth** | 500 GB/month | 1 TB/month |

The merged server container (API + SPA + Discord bot) runs under 768 MB in
steady state. Add a **swap file** on RAM-constrained VPS to absorb transient
yt-dlp/ffmpeg spikes:

```bash
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Providers that fit: Hetzner CX22 (2 vCPU, 4 GB, ~€6/month), Contabo VPS S
(4 vCPU, 4 GB, ~€5/month).

## TODO

- [ ] Real-time sync over WebSockets (frontend currently polls `/songs`)
- [ ] UI polish
