# Back2Back 🎵

Música sincronizada en tiempo real con tus amigos. Reemplaza el flujo de Discord de pasar enlaces a bots.

## Tech Stack

- **Runtime**: Bun
- **Backend**: Hono + WebSockets
- **Frontend**: React + Vite
- **DB**: SQLite + Drizzle ORM
- **Audio**: yt-dlp + @discordjs/voice
- **Bot**: Discord.js

## Arquitectura

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

## Desarrollo

### Requisitos
- Bun
- yt-dlp (audio en desarrollo local)
- Docker (opcional, para el deploy con Compose)
- Discord Bot Token

### Instalar

```bash
# Clonar e instalar dependencias
git clone <repo>
cd back2back
bun install

# Copiar variables de entorno
cp .env.example .env
# Editar .env con tu DISCORD_TOKEN

# Generar migraciones de DB
bun db:generate
bun db:push
```

### Ejecutar

**Opción 1: Todo con Docker (recomendado para producción)**
```bash
docker compose up
```

**Opción 2: Desarrollo local**
```bash
# Instalar yt-dlp
pip install yt-dlp

# Terminal 1: Server
cd packages/server && bun dev

# Terminal 2: Frontend
cd packages/web && bun dev
```

O usa el script:
```bash
./dev.sh
```

### URLs
- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## API

### Salas
- `GET /api/rooms/:id` - Obtener sala
- `GET /api/rooms/:id/songs` - Obtener canciones
- `POST /api/rooms/:id/songs` - Añadir canción `{ url, addedBy }`
- `POST /api/rooms/:id/songs/:songId/vote` - Votar

### Discord Bot
- `/play <url>` - Añadir a la cola y reproducir
- `/listen` - Unirse al canal y empezar la cola
- `/stop` - Parar y desconectar
- `/skip` - Saltar canción actual
- `/queue` - Ver la cola
- `/reset` - Resetear canciones reproducidas

## Deploy (Coolify)

```bash
# 1. Push a tu repo
git push

# 2. En Coolify, crear nueva app Docker Compose
# 3. Apuntar al docker-compose.yml
# 4. Agregar variables de entorno:
#    - DISCORD_TOKEN=tu_token
#    - DISCORD_CLIENT_ID=tu_id
#    - DISCORD_CLIENT_SECRET=tu_secret
```

## TODO

- [ ] Discord OAuth2 para login
- [ ] WebSockets completos (sync real-time)
- [ ] UI mejorada
- [ ] Cola automática (siguiente canción)
- [ ] Bot slash commands completos
