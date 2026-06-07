# Deploying to Fly.io

Fly is the recommended prototype host for this version because the app runs a single Node process with HTTP, LiveKit token generation, and a WebSocket transcript stream.

## First Deploy

Install and authenticate the Fly CLI:

```bash
brew install flyctl
fly auth login
```

Create the app. If `ycmoss` is already taken, choose another name and update `app` in `fly.toml`.

```bash
fly apps create ycmoss
```

Set secrets:

```bash
fly secrets set LIVEKIT_URL="wss://your-project.livekit.cloud"
fly secrets set LIVEKIT_API_KEY="your-livekit-api-key"
fly secrets set LIVEKIT_API_SECRET="your-livekit-api-secret"
fly secrets set OPENAI_API_KEY="your-openai-api-key"
```

Deploy:

```bash
fly deploy
```

## Fly Pipeline Deploy

This project is deployed through Fly's own pipeline, not GitHub Actions.

Use the Fly dashboard/pipeline connection for automatic deploys from the GitHub repo. Keep runtime secrets configured in Fly, not in GitHub Actions:

```bash
fly secrets set LIVEKIT_URL="wss://your-project.livekit.cloud" -a ycmoss
fly secrets set LIVEKIT_API_KEY="your-livekit-api-key" -a ycmoss
fly secrets set LIVEKIT_API_SECRET="your-livekit-api-secret" -a ycmoss
fly secrets set OPENAI_API_KEY="your-openai-api-key" -a ycmoss
```

The Docker image uses pnpm through Corepack. Local development uses the same package manager:

```bash
pnpm install
pnpm dev
```

Open the two prototype paths:

```text
https://ycmoss.fly.dev/founder
https://ycmoss.fly.dev/prospect
```

Both pages join the same default room. Add `?room=some-room-name` to put both people into a specific shared room.

## LiveKit STT Worker

Live transcription requires the web/API server and the LiveKit Agents worker:

```bash
pnpm start
pnpm start:stt
```

Run them as separate long-running processes in production. The worker joins rooms as a silent transcriber and publishes speech-to-text segments back to the UI through LiveKit's `lk.transcription` text stream.

The API includes a `transcriber` room-agent dispatch in LiveKit join tokens. Keep `LIVEKIT_TRANSCRIBER_AGENT_NAME` aligned between the API server and worker if you change it.
