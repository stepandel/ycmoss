# Zoom App Setup

This branch converts Discovery Co-Pilot into a Zoom App-compatible web surface while preserving the existing browser/LiveKit prototype.

## Zoom Marketplace Fields

Create a Zoom App in the Zoom App Marketplace and use these URLs, replacing the host with your deployed HTTPS domain:

```text
Home URL: https://your-app.example.com/zoom
Direct landing URL: https://your-app.example.com/zoom/install
OAuth Redirect URL: https://your-app.example.com/zoom/oauth/callback
Event notification endpoint URL: https://your-app.example.com/zoom/rtms/webhook
Allowed domains:
- your-app.example.com
```

The Zoom App webview opens `/zoom`, which renders the founder co-pilot. When launched inside a meeting, the client calls `@zoom/appssdk` and uses Zoom's meeting UUID as the shared co-pilot room name.

The server decorates HTML responses with the Zoom-required OWASP secure headers:

```text
Strict-Transport-Security
X-Content-Type-Options
Content-Security-Policy
Referrer-Policy
```

## Required Marketplace Capabilities

Enable Zoom Apps / in-client app access. The frontend currently requests these Zoom Apps SDK capabilities:

```text
getRunningContext
getMeetingContext
getMeetingUUID
getUserContext
shareApp
showNotification
startRTMS
getRTMSStatus
onRTMSStatusChange
onRunningContextChange
onMyUserContextChange
```

## Environment

Add these values in addition to the existing LiveKit and MiniMax values:

```text
ZOOM_CLIENT_ID=your-zoom-client-id
ZOOM_CLIENT_SECRET=your-zoom-client-secret
ZOOM_REDIRECT_URI=https://your-app.example.com/zoom/oauth/callback
ZOOM_OAUTH_STATE_SECRET=replace-with-a-random-state-signing-secret
ZOOM_INSTALL_STATE=replace-with-a-random-state-value
ZOOM_DEEPLINK_API_URL=https://api.zoom.us/v2/zoomapp/deeplink/
ZOOM_DEEPLINK_ACTION=go
ZOOM_WEBHOOK_SECRET_TOKEN=your-zoom-webhook-secret-token
ZOOM_TRANSCRIPT_INGEST_SECRET=replace-with-a-random-shared-secret
ZM_RTMS_CLIENT=your-zoom-rtms-client-id
ZM_RTMS_SECRET=your-zoom-rtms-client-secret
ZOOM_RTMS_POLL_INTERVAL_MS=20
```

`/zoom/install` redirects users into Zoom OAuth with a signed, per-install `state` cookie. The callback validates that state, exchanges the authorization code at `https://zoom.us/oauth/token`, calls the Zoom Apps deep-link API, and redirects the user into the Zoom client. `ZOOM_INSTALL_STATE` remains supported as a static fallback, but `ZOOM_OAUTH_STATE_SECRET` is preferred.

## Transcript Ingestion

Zoom Apps SDK provides the in-client app frame and meeting context, but the browser app does not receive raw Zoom meeting audio by default. Inside a Zoom meeting, the app can request RTMS startup with `startRTMS()`. Your Zoom app still needs RTMS features/scopes and a receiving server configured in the Marketplace.

Subscribe the app to RTMS start/stop events and point the event notification endpoint at:

```text
https://your-app.example.com/zoom/rtms/webhook
```

The endpoint handles Zoom `endpoint.url_validation` challenges using `ZOOM_WEBHOOK_SECRET_TOKEN`, verifies signed webhooks when that secret is configured, starts a transcript-only `@zoom/rtms` client on `meeting.rtms_started`, and stops the client on `meeting.rtms_stopped`.

For non-RTMS adapters or manual testing, the app also exposes a direct transcript endpoint:

```bash
curl -X POST "https://your-app.example.com/api/calls/zoom-MEETING_UUID/transcript" \
  -H "Content-Type: application/json" \
  -H "x-transcript-ingest-secret: $ZOOM_TRANSCRIPT_INGEST_SECRET" \
  -d '{"speaker":"prospect","text":"We lose about six hours every Friday reconciling renewals."}'
```

The endpoint uses the same co-pilot analysis pipeline as the existing LiveKit transcription bridge and broadcasts updates to connected app clients over `/ws`.

## Local Development

Run the app locally as before:

```bash
pnpm dev
```

Open `http://127.0.0.1:5173/zoom` to test the Zoom App surface in a normal browser. Outside the Zoom client, the Zoom status pill will show `browser` and the app falls back to the default `discovery-demo` room unless a `room` query parameter is provided.
