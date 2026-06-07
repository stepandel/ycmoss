# Deploying to Fly.io

Fly is the recommended prototype host for this version because the app runs a Node web/API process plus a long-running LiveKit Agents worker for speech-to-text.

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
fly secrets set MINIMAX_API_KEY="your-minimax-api-key"
```

Deploy:

```bash
fly deploy
```

`fly.toml` defines two process groups:

- `app` runs HTTP, LiveKit token generation, the Vite build, and `/ws`.
- `stt` runs the LiveKit transcriber worker.

For an existing Fly app, make sure both process groups have at least one Machine after deploying:

```bash
fly scale count app=1 stt=1 -a ycmoss
```

## Fly Pipeline Deploy

This project is deployed through Fly's own pipeline, not GitHub Actions.

Use the Fly dashboard/pipeline connection for automatic deploys from the GitHub repo. Keep runtime secrets configured in Fly, not in GitHub Actions:

```bash
fly secrets set LIVEKIT_URL="wss://your-project.livekit.cloud" -a ycmoss
fly secrets set LIVEKIT_API_KEY="your-livekit-api-key" -a ycmoss
fly secrets set LIVEKIT_API_SECRET="your-livekit-api-secret" -a ycmoss
fly secrets set MINIMAX_API_KEY="your-minimax-api-key" -a ycmoss
```

If Moss context retrieval should run in production, add the Moss secrets too:

```bash
fly secrets set MOSS_PROJECT_ID="your-moss-project-id" -a ycmoss
fly secrets set MOSS_PROJECT_KEY="your-moss-project-key" -a ycmoss
fly secrets set MOSS_INDEX_NAME="your-moss-index-name" -a ycmoss
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

Run them as separate long-running processes in production. On Fly, the `app` and `stt` process groups in `fly.toml` run these separately. The public HTTP service is attached only to `app`; the `stt` process has no public port and stays available to accept LiveKit agent dispatches. The worker joins rooms as a silent transcriber and publishes speech-to-text segments back to the UI through LiveKit's `lk.transcription` text stream.

The API includes a `transcriber` room-agent dispatch in LiveKit join tokens. Keep `LIVEKIT_TRANSCRIBER_AGENT_NAME` aligned between the API server and worker if you change it.
