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

## GitHub Actions Deploy

This repo includes `.github/workflows/fly.yml`, which builds the app and deploys to Fly on every push to `main`. It can also be run manually from the GitHub Actions tab.

Create a Fly deploy token:

```bash
fly tokens create deploy -a ycmoss
```

Store it in GitHub:

```bash
gh secret set FLY_API_TOKEN --repo stepandel/ycmoss --body "your-fly-deploy-token"
```

The workflow uses Fly's official GitHub Actions setup:

```yaml
uses: superfly/flyctl-actions/setup-flyctl@master
```

It deploys explicitly to the app configured in `fly.toml`:

```bash
flyctl deploy --remote-only -a ycmoss
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
