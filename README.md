# Back2Back 🎵

Synchronized music playback with your friends. Replaces the Discord workflow of passing links to bots.

## Tech Stack

- **Runtime**: Bun
- **Backend**: Hono + WebSockets
- **Frontend**: React + Vite
- **DB**: SQLite + Drizzle ORM
- **Audio**: yt-dlp + @discordjs/voice
- **Bot**: Discord.js

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│   Server    │────▶│   yt-dlp    │
│  (React)    │     │   (Hono)    │     │  (Audio)    │
└─────────────┘     └─────────────┘     └─────────────┘
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
- yt-dlp (for local audio playback)
- Docker (optional, for Compose-based deploy)
- Discord Bot Token

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
```bash
# Install yt-dlp
pip install yt-dlp

# Terminal 1: Server
cd packages/server && bun dev

# Terminal 2: Frontend
cd packages/web && bun dev
```

Or use the convenience script:
```bash
./dev.sh
```

### URLs
- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## API

### Rooms
- `GET /api/rooms/:id` — Get room
- `GET /api/rooms/:id/songs` — List songs
- `POST /api/rooms/:id/songs` — Add song `{ url, addedBy }`
- `POST /api/rooms/:id/songs/:songId/vote` — Vote on a song

### Discord Bot
- `/play <url>` — Add to queue and play
- `/listen` — Join voice channel and start the queue
- `/stop` — Stop playback and disconnect
- `/skip` — Skip the current song
- `/queue` — Show the current queue
- `/reset` — Reset played songs

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
The domain goes on the **`web`** service only — `server` is internal (reached
through nginx in the web image, never published to the host).

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

- Coolify → `web` service → **Domains**: `http://b2b.nxssie.dev` (**`http://`**, not
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

## TODO

- [ ] WebSocket real-time sync (frontend)
- [ ] UI polish
