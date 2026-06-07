# Discovery Co-Pilot

A prototype sales discovery co-pilot for live customer calls.

The app uses LiveKit for the video room, streams transcript turns to a Node WebSocket server, and shows the founder GPT-powered discovery stage and next-question recommendations.

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
- LiveKit Agents for streaming speech-to-text
- Express for API routes
- `ws` for transcript/co-pilot WebSocket events
- gpt-5.4-mini for co-pilot analysis
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
LIVEKIT_TRANSCRIBER_AGENT_NAME=transcriber
LIVEKIT_STT_MODEL=deepgram/nova-3
LIVEKIT_STT_LANGUAGE=en
```

Configure OpenAI:

```text
OPENAI_API_KEY=your-openai-api-key
OPENAI_MODEL=gpt-5.4-mini
COPILOT_ANALYSIS_INTERVAL_MS=10000
OPENAI_PITCH_DRIFT_MODEL=gpt-5.4-mini
PITCH_DRIFT_INTERVAL_MS=3000
```

Without `OPENAI_API_KEY`, the server exits on startup.

Optionally configure Moss context retrieval:

```text
MOSS_PROJECT_ID=your-moss-project-id
MOSS_PROJECT_KEY=your-moss-project-key
MOSS_INDEX_NAME=your-moss-index-name
MOSS_TOP_K=5
MOSS_MIN_SCORE=0
MOSS_LOAD_INDEX=true
MOSS_AUTO_REFRESH=false
MOSS_POLLING_INTERVAL_SECONDS=300
```

When all three required Moss values are set, the server queries Moss before each co-pilot analysis and injects the returned snippets into the GPT prompt as `mossContext`. If Moss is unavailable, the co-pilot logs a warning and falls back to transcript-only analysis.

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

Run the production STT worker in a separate process:

```bash
pnpm start:stt
```

In production, the compiled `build/server/index.js` serves the built Vite app from `dist`, exposes `/api/livekit/token`, and keeps the `/ws` transcript stream available. The compiled `build/agents/transcriber.js` worker joins rooms as a silent LiveKit Agent and publishes speech-to-text segments back to the UI. On Fly, `fly.toml` runs these as separate `app` and `stt` process groups.

## Live Transcription

The UI listens for LiveKit Agent transcriptions on the `lk.transcription` text stream and renders interim and final speech-to-text segments in the founder transcript panel. Final STT segments are also forwarded into the co-pilot WebSocket stream so suggestions can react to spoken turns.

`pnpm dev` starts `server/index.ts`, `agents/transcriber.ts`, and Vite together. The join token requests a `transcriber` LiveKit Agent dispatch when a room is created, and the API also creates explicit dispatches as participants join. For two-sided transcription, each participant gets a targeted transcriber dispatch.

## Co-Pilot Analysis

The server caches transcript turns per room and runs co-pilot analysis on a throttle controlled by `COPILOT_ANALYSIS_INTERVAL_MS`. Each analysis returns the current discovery stage plus 1-3 recommended next questions for the rep.

If Moss is configured, the analysis query includes the current stage, known facts, open gaps, and recent transcript. Retrieved Moss snippets are treated as reference material for playbook guidance, prospect notes, company notes, and call-stage context; transcript facts still take priority.

The server also runs a separate LLM-based discovery guardrail classifier after founder turns. It uses `OPENAI_PITCH_DRIFT_MODEL` and `PITCH_DRIFT_INTERVAL_MS` to detect pitch drift and classify whether the founder is collecting concrete facts or fluff like empty compliments, vague enthusiasm, and hypothetical willingness. The founder UI shows an always-on Fluff Guard status plus a gentle warning when the founder drifts into pitching or validation.

## Deploy

Fly.io is the recommended prototype host because the current app needs long-running Node processes for WebSockets and LiveKit speech-to-text.

See [DEPLOY.md](./DEPLOY.md) for the full Fly setup.

Short version:

```bash
fly apps create ycmoss
fly secrets set LIVEKIT_URL="wss://your-project.livekit.cloud"
fly secrets set LIVEKIT_API_KEY="your-livekit-api-key"
fly secrets set LIVEKIT_API_SECRET="your-livekit-api-secret"
fly secrets set OPENAI_API_KEY="your-openai-api-key"
fly deploy
fly scale count app=1 stt=1 -a ycmoss
```

## Notes

- The founder UI has manual/demo transcript controls, but live calls depend on the `stt` process group being running in production.
- The server exits on startup unless LiveKit credentials and `OPENAI_API_KEY` are configured.
- Co-pilot state is currently in-memory per Node process, which is fine for a prototype but should move to durable/shared storage before scaling across machines.
