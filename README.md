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

## Deploy (Coolify)

```bash
# 1. Push to your repo
git push

# 2. In Coolify, create a new Docker Compose app
# 3. Point it to docker-compose.yml
# 4. Add environment variables:
#    - DISCORD_TOKEN=your_token
#    - DISCORD_CLIENT_ID=your_id
#    - DISCORD_CLIENT_SECRET=your_secret
#    - DISCORD_REDIRECT_URI=https://your-domain/auth/discord/callback
#    - FRONTEND_URL=https://your-domain
#    - JWT_SECRET=$(openssl rand -hex 32)
```

## TODO

- [ ] WebSocket real-time sync (frontend)
- [ ] UI polish
