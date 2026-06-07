# Discovery Co-Pilot

A prototype sales discovery co-pilot for live customer calls.

The app uses LiveKit for the video room, streams transcript turns to a Node WebSocket server, and shows the founder restrained next-question suggestions from either OpenAI or a local fallback heuristic.

## Prototype Paths

The prototype has two role-specific pages that join the same room:

- `/founder` - call UI plus transcript simulator, captured facts, call-state gaps, and co-pilot suggestions.
- `/prospect` - call-only UI with no co-pilot, transcript, or internal state.

Both pages use the default room `discovery-demo`. Add a `room` query param to share a specific room:

```text
http://127.0.0.1:5173/founder?room=acme-demo
http://127.0.0.1:5173/prospect?room=acme-demo
```

## Stack

- React + Vite frontend
- LiveKit React components for the call surface
- Express for API routes
- `ws` for transcript/co-pilot WebSocket events
- OpenAI for suggestions when configured
- pnpm for package management
- Fly.io deployment via Docker

## Local Setup

Install dependencies:

```bash
pnpm install
```

Create local environment config:

```bash
cp .env.example .env
```

Configure LiveKit:

```text
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your-livekit-api-key
LIVEKIT_API_SECRET=your-livekit-api-secret
```

Optionally configure OpenAI:

```text
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-4.1-mini
```

Without `OPENAI_API_KEY`, the app uses a deterministic local suggestion engine.

Start the dev server:

```bash
pnpm dev
```

Open:

```text
http://127.0.0.1:5173/founder
http://127.0.0.1:5173/prospect
```

## Production Build

Build the frontend:

```bash
pnpm run build
```

Run the production Node server:

```bash
pnpm start
```

In production, `server/index.mjs` serves the built Vite app from `dist`, exposes `/api/livekit/token`, and keeps the `/ws` transcript stream available.

## Deploy

Fly.io is the recommended prototype host because the current app needs a long-running Node process for WebSockets.

See [DEPLOY.md](./DEPLOY.md) for the full Fly setup.

Short version:

```bash
fly apps create ycmoss
fly secrets set LIVEKIT_URL="wss://your-project.livekit.cloud"
fly secrets set LIVEKIT_API_KEY="your-livekit-api-key"
fly secrets set LIVEKIT_API_SECRET="your-livekit-api-secret"
fly secrets set OPENAI_API_KEY="your-openai-api-key"
fly deploy
```

## Notes

- The transcript stream is simulated through the founder UI for now.
- LiveKit video requires real LiveKit credentials.
- Co-pilot state is currently in-memory per Node process, which is fine for a prototype but should move to durable/shared storage before scaling across machines.
