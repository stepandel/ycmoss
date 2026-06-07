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

Open the two prototype paths:

```text
https://ycmoss.fly.dev/founder
https://ycmoss.fly.dev/prospect
```

Both pages join the same default room. Add `?room=some-room-name` to put both people into a specific shared room.
