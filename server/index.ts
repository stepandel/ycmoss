import "dotenv/config";
import express from "express";
import http from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MossClient, type QueryResultDocumentInfo } from "@moss-dev/moss";
import rtms from "@zoom/rtms";
import OpenAI from "openai";
import { AccessToken, AgentDispatchClient, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";
import { WebSocket, WebSocketServer, type RawData } from "ws";

declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

type Speaker = "rep" | "prospect";

type TranscriptTurn = {
  id: string;
  speaker: Speaker;
  text: string;
  final: boolean;
  timestamp: string;
};

type TranscriptEvent = {
  type: "transcript.turn";
  callId: string;
  id?: string;
  speaker: Speaker;
  text: string;
  final?: boolean;
  timestamp?: string;
};

type SubscribeEvent = {
  type: "call.subscribe";
  callId: string;
};

type TranscriptIngestRequest = {
  speaker?: Speaker;
  text?: string;
  id?: string;
  final?: boolean;
  timestamp?: string;
};

type CopilotError = {
  type: "copilot.error";
  callId: string;
  error: string;
};

type DiscoveryStage =
  | "Just here to learn"
  | "When did it last happen"
  | "Quantify the pain"
  | "What have they tried?"
  | "Are they already solving it?"
  | "Ask for commitment"
  | "Lock next steps";

type NextQuestion = {
  priority: "low" | "medium" | "high";
  question: string;
  reason: string;
};

type CopilotAnalysis = {
  stage: DiscoveryStage;
  nextQuestions: NextQuestion[];
};

type PitchDriftState = "on_discovery_path" | "drifting" | "pitching" | "recovering";

type PitchDriftAnalysis = {
  state: PitchDriftState;
  confidence: number;
  shouldWarn: boolean;
  warning: string;
  recoveryQuestion: string;
  reasons: string[];
};

type LlmAnalysis = CopilotAnalysis & {
  facts: string[];
  completedGaps: string[];
};

type MossContextSnippet = {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, string>;
};

type CallState = {
  transcript: TranscriptTurn[];
  facts: string[];
  gaps: Set<string>;
  analysis: CopilotAnalysis;
  pitchDrift: PitchDriftAnalysis;
  lastAnalysisAt: number;
  lastPitchDriftAt: number;
  pendingAnalysis?: Promise<CopilotAnalysis>;
  pendingPitchDrift?: Promise<PitchDriftAnalysis>;
};

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const transcriberAgentName = process.env.LIVEKIT_TRANSCRIBER_AGENT_NAME ?? "transcriber";
const copilotAnalysisIntervalMs = Number(process.env.COPILOT_ANALYSIS_INTERVAL_MS ?? 10_000);
const pitchDriftIntervalMs = Number(process.env.PITCH_DRIFT_INTERVAL_MS ?? 3_000);
const requiredLiveKitEnv = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const;
const missingLiveKitEnv = requiredLiveKitEnv.filter((key) => !process.env[key]);
const requiredOpenAiEnv = ["OPENAI_API_KEY"] as const;
const missingOpenAiEnv = requiredOpenAiEnv.filter((key) => !process.env[key]);
const mossProjectId = process.env.MOSS_PROJECT_ID?.trim();
const mossProjectKey = process.env.MOSS_PROJECT_KEY?.trim();
const mossIndexName = process.env.MOSS_INDEX_NAME?.trim();
const mossTopK = Number(process.env.MOSS_TOP_K ?? 5);
const mossMinScore = Number(process.env.MOSS_MIN_SCORE ?? 0);
const mossShouldLoadIndex = process.env.MOSS_LOAD_INDEX !== "false";
const mossAutoRefresh = process.env.MOSS_AUTO_REFRESH === "true";
const mossPollingIntervalInSeconds = Number(process.env.MOSS_POLLING_INTERVAL_SECONDS ?? 300);
const mossCachePath = process.env.MOSS_CACHE_PATH?.trim();
const isMossConfigured = Boolean(mossProjectId && mossProjectKey && mossIndexName);
const zoomClientId = process.env.ZOOM_CLIENT_ID?.trim();
const zoomClientSecret = process.env.ZOOM_CLIENT_SECRET?.trim();
const zoomRedirectUri = process.env.ZOOM_REDIRECT_URI?.trim();
const zoomInstallState = process.env.ZOOM_INSTALL_STATE?.trim();
const zoomWebhookSecretToken = process.env.ZOOM_WEBHOOK_SECRET_TOKEN?.trim();
const zoomOAuthStateSecret =
  process.env.ZOOM_OAUTH_STATE_SECRET?.trim() || zoomClientSecret || zoomWebhookSecretToken || zoomInstallState;
const zoomTranscriptIngestSecret = process.env.ZOOM_TRANSCRIPT_INGEST_SECRET?.trim();
const zoomDeepLinkApiUrl = process.env.ZOOM_DEEPLINK_API_URL?.trim() || "https://api.zoom.us/v2/zoomapp/deeplink/";
const zoomDeepLinkAction = process.env.ZOOM_DEEPLINK_ACTION?.trim() || "go";
const zoomRtmsClients = new Map<string, InstanceType<typeof rtms.Client>>();
const zoomOAuthStateCookieName = "dc_zoom_oauth_state";
const zoomOAuthStateMaxAgeMs = 10 * 60 * 1000;

if (missingLiveKitEnv.length) {
  console.error(`Missing required LiveKit environment: ${missingLiveKitEnv.join(", ")}`);
  process.exit(1);
}

if (missingOpenAiEnv.length) {
  console.error(`Missing required OpenAI environment: ${missingOpenAiEnv.join(", ")}`);
  process.exit(1);
}

const livekitUrl = process.env.LIVEKIT_URL as string;
const livekitApiKey = process.env.LIVEKIT_API_KEY as string;
const livekitApiSecret = process.env.LIVEKIT_API_SECRET as string;
const openaiApiKey = process.env.OPENAI_API_KEY as string;
const livekitApiHost = livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = [path.resolve(__dirname, "../dist"), path.resolve(__dirname, "../../dist")].find(existsSync) ?? path.resolve(__dirname, "../dist");
const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const openai = new OpenAI({ apiKey: openaiApiKey });
const moss = isMossConfigured ? new MossClient(mossProjectId as string, mossProjectKey as string) : undefined;
let mossLoadPromise: Promise<string> | undefined;
const agentDispatchClient = new AgentDispatchClient(livekitApiHost, livekitApiKey, livekitApiSecret);
const calls = new Map<string, CallState>();
const callSubscribers = new Map<string, Set<WebSocket>>();
const discoveryStageGuide = [
  {
    stage: "Just here to learn",
    goal: "Get your idea off the table.",
    doneWhen: "They are talking freely about their own world, not reaching for a pitch."
  },
  {
    stage: "When did it last happen",
    goal: "Pin them to a specific, recent instance.",
    doneWhen: "You are inside one concrete past event, not generalities."
  },
  {
    stage: "Quantify the pain",
    goal: "Establish cost, frequency, and downstream consequence of that instance.",
    doneWhen: "You can state how much it hurts and how often."
  },
  {
    stage: "What have they tried?",
    goal: "Uncover what they have already tried, built, or paid for.",
    doneWhen: "You know whether real money or time has been spent."
  },
  {
    stage: "Are they already solving it?",
    goal: "Determine if they are solving this now or it is a someday item.",
    doneWhen: "You know it is a find-budget problem, not a nice-to-have."
  },
  {
    stage: "Ask for commitment",
    goal: "Float your direction lightly and ask for something costly: time, an intro, or money.",
    doneWhen: "They either advance or dodge."
  },
  {
    stage: "Lock next steps",
    goal: "Lock a concrete dated advancement, or explicitly name that there is not one.",
    doneWhen: "The next step, or its confirmed absence, is unambiguous."
  }
] as const satisfies ReadonlyArray<{ stage: DiscoveryStage; goal: string; doneWhen: string }>;
const discoveryStages = discoveryStageGuide.map((entry) => entry.stage);
const defaultOpenGaps = [
  "concrete instance",
  "cost & frequency",
  "existing workaround / spend",
  "decision power",
  "commitment"
];
const discoveryStagePrompt = discoveryStageGuide
  .map((entry, index) => `${index + 1}. ${entry.stage} — Goal: ${entry.goal} Done when: ${entry.doneWhen}`)
  .join("\n");
const defaultAnalysis: CopilotAnalysis = {
  stage: "Just here to learn",
  nextQuestions: [
    {
      priority: "medium",
      question: "Before I say anything about our idea, can you tell me how this shows up in your world?",
      reason: "Starts by taking the pitch off the table."
    },
    {
      priority: "low",
      question: "I am mostly here to understand, so feel free to tell me where this is not a problem.",
      reason: "Gives them permission to speak freely."
    }
  ]
};
const defaultPitchDrift: PitchDriftAnalysis = {
  state: "on_discovery_path",
  confidence: 0,
  shouldWarn: false,
  warning: "",
  recoveryQuestion: "Can you walk me through the last time this happened?",
  reasons: []
};

const zoomAppContentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https: wss: ws:",
  "worker-src 'self' blob:",
  "form-action 'self'"
].join("; ");

app.use(
  express.json({
    verify: (req, _res, buffer) => {
      (req as express.Request).rawBody = buffer.toString("utf8");
    }
  })
);

app.use((_req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", zoomAppContentSecurityPolicy);
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.get("/api/config", (_req, res) => {
  res.json({
    livekitUrl
  });
});

app.get("/api/zoom/config", (_req, res) => {
  res.json({
    configured: Boolean(zoomClientId && zoomClientSecret && zoomRedirectUri),
    rtmsConfigured: Boolean(process.env.ZM_RTMS_CLIENT && process.env.ZM_RTMS_SECRET),
    redirectUri: zoomRedirectUri
  });
});

app.get("/zoom/install", (req, res) => {
  if (!zoomClientId || !zoomRedirectUri) {
    return res.status(501).send("Zoom install is not configured. Set ZOOM_CLIENT_ID and ZOOM_REDIRECT_URI.");
  }

  const state = createZoomOAuthState();
  if (state && state !== zoomInstallState) {
    setZoomOAuthStateCookie(req, res, state);
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: zoomClientId,
    redirect_uri: zoomRedirectUri,
    ...(state ? { state } : {})
  });

  res.redirect(`https://zoom.us/oauth/authorize?${params.toString()}`);
});

type ZoomOAuthTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

function basicAuthHeader(clientId: string, clientSecret: string) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function exchangeZoomAuthorizationCode(code: string): Promise<ZoomOAuthTokenResponse> {
  if (!zoomClientId || !zoomClientSecret || !zoomRedirectUri) {
    throw new Error("Zoom OAuth is not configured. Set ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, and ZOOM_REDIRECT_URI.");
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: zoomRedirectUri
  });
  const response = await fetch(`https://zoom.us/oauth/token?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(zoomClientId, zoomClientSecret)
    }
  });
  const payload = (await response.json().catch(() => ({}))) as ZoomOAuthTokenResponse & { reason?: string; message?: string };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.reason || payload.message || "Zoom OAuth token exchange failed.");
  }

  return payload;
}

function parseZoomDeepLink(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined;

  const record = payload as Record<string, unknown>;
  return (
    asNonEmptyString(record.deeplink) ??
    asNonEmptyString(record.deep_link) ??
    asNonEmptyString(record.deepLink) ??
    asNonEmptyString(record.url)
  );
}

async function createZoomDeepLink(accessToken: string) {
  const response = await fetch(zoomDeepLinkApiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action: zoomDeepLinkAction.slice(0, 256) })
  });
  const payload = await response.json().catch(() => ({}));
  const deepLink = parseZoomDeepLink(payload);
  if (!response.ok || !deepLink) {
    const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    throw new Error(asNonEmptyString(record.message) || asNonEmptyString(record.reason) || "Zoom deep link generation failed.");
  }

  return deepLink;
}

app.get("/zoom/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const state = typeof req.query.state === "string" ? req.query.state : undefined;

  if (!code) {
    return res.status(400).send("Zoom OAuth callback did not include a code.");
  }

  if (!isZoomOAuthStateValid(req, state)) {
    return res.status(400).send("Zoom OAuth state did not match.");
  }

  try {
    clearZoomOAuthStateCookie(req, res);
    const token = await exchangeZoomAuthorizationCode(code);
    const deepLink = await createZoomDeepLink(token.access_token as string);
    return res.redirect(deepLink);
  } catch (error) {
    console.error("zoom_oauth_callback_error", error);
    const message = escapeHtml(error instanceof Error ? error.message : "Zoom OAuth callback failed.");
    return res.status(500).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Discovery Co-Pilot Authorization Failed</title>
  </head>
  <body>
    <h1>Discovery Co-Pilot could not launch in Zoom</h1>
    <p>${message}</p>
  </body>
</html>`);
  }
});

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseTokenRequest(body: unknown): { roomName: string; identity: string } | null {
  if (!body || typeof body !== "object") return null;

  const record = body as Record<string, unknown>;
  const roomName = asNonEmptyString(record.roomName);
  const identity = asNonEmptyString(record.identity);
  if (!roomName || !identity) return null;

  return { roomName, identity };
}

function transcriberDispatchMetadata(identity: string) {
  return JSON.stringify({ participantIdentity: identity });
}

function sanitizeZoomRoomSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 96);
}

function zoomCallIdFromPayload(payload: Record<string, unknown>) {
  const meetingUuid =
    asNonEmptyString(payload.meeting_uuid) ??
    asNonEmptyString(payload.webinar_uuid) ??
    asNonEmptyString(payload.session_id) ??
    asNonEmptyString(payload.engagement_id);

  return meetingUuid ? `zoom-${sanitizeZoomRoomSegment(meetingUuid)}` : undefined;
}

function speakerFromZoomName(userName?: string): Speaker {
  const normalized = userName?.toLowerCase() ?? "";
  return normalized.includes("founder") || normalized.includes("rep") || normalized.includes("sales")
    ? "rep"
    : "prospect";
}

function zoomEncryptedToken(plainToken: string) {
  if (!zoomWebhookSecretToken) return undefined;
  return createHmac("sha256", zoomWebhookSecretToken).update(plainToken).digest("hex");
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signZoomOAuthState(value: string) {
  if (!zoomOAuthStateSecret) return undefined;
  return createHmac("sha256", zoomOAuthStateSecret).update(value).digest("base64url");
}

function createZoomOAuthState() {
  const payload = `${randomUUID()}.${Date.now()}`;
  const signature = signZoomOAuthState(payload);
  return signature ? `${payload}.${signature}` : zoomInstallState;
}

function parseCookies(cookieHeader?: string) {
  const cookies = new Map<string, string>();
  if (!cookieHeader) return cookies;

  for (const cookie of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = cookie.trim().split("=");
    if (!rawName || rawValue.length === 0) continue;
    try {
      cookies.set(rawName, decodeURIComponent(rawValue.join("=")));
    } catch {
      cookies.set(rawName, rawValue.join("="));
    }
  }

  return cookies;
}

function isSecureRequest(req: express.Request) {
  return req.secure || req.get("x-forwarded-proto") === "https";
}

function setZoomOAuthStateCookie(req: express.Request, res: express.Response, state: string) {
  res.cookie(zoomOAuthStateCookieName, state, {
    httpOnly: true,
    maxAge: zoomOAuthStateMaxAgeMs,
    sameSite: "lax",
    secure: isSecureRequest(req)
  });
}

function clearZoomOAuthStateCookie(req: express.Request, res: express.Response) {
  res.clearCookie(zoomOAuthStateCookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req)
  });
}

function isSignedZoomOAuthStateValid(state: string) {
  const parts = state.split(".");
  if (parts.length !== 3) return false;

  const [nonce, timestampText, signature] = parts;
  const timestamp = Number(timestampText);
  if (!nonce || !Number.isFinite(timestamp) || Date.now() - timestamp > zoomOAuthStateMaxAgeMs) return false;

  const expectedSignature = signZoomOAuthState(`${nonce}.${timestampText}`);
  return Boolean(expectedSignature && constantTimeEqual(signature, expectedSignature));
}

function isZoomOAuthStateValid(req: express.Request, state?: string) {
  if (!state) return !zoomOAuthStateSecret && !zoomInstallState;
  if (zoomInstallState && state === zoomInstallState) return true;

  const cookieState = parseCookies(req.get("cookie")).get(zoomOAuthStateCookieName);
  return Boolean(cookieState && constantTimeEqual(state, cookieState) && isSignedZoomOAuthStateValid(state));
}

function verifyZoomWebhookSignature(req: express.Request) {
  if (!zoomWebhookSecretToken) return true;

  const timestamp = req.get("x-zm-request-timestamp");
  const signature = req.get("x-zm-signature");
  const rawBody = req.rawBody;
  if (!timestamp || !signature || !rawBody) return false;

  const expectedSignature = `v0=${createHmac("sha256", zoomWebhookSecretToken)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;

  return constantTimeEqual(signature, expectedSignature);
}

function isRoomMissingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("room not found") || message.includes("requested room does not exist") || message.includes("not found");
}

async function ensureTranscriberDispatch(roomName: string, identity: string) {
  const metadata = transcriberDispatchMetadata(identity);
  try {
    const dispatches = await agentDispatchClient.listDispatch(roomName);
    const existingDispatch = dispatches.find(
      (dispatch) => dispatch.agentName === transcriberAgentName && dispatch.metadata === metadata
    );
    if (existingDispatch) return;

    await agentDispatchClient.createDispatch(roomName, transcriberAgentName, { metadata });
  } catch (error) {
    if (isRoomMissingError(error)) return;
    console.warn("transcriber_dispatch_error", error instanceof Error ? error.message : error);
  }
}

app.post("/api/livekit/token", async (req, res) => {
  try {
    const tokenRequest = parseTokenRequest(req.body);
    if (!tokenRequest) {
      return res.status(400).json({ error: "roomName and identity are required." });
    }

    const { roomName, identity } = tokenRequest;
    const token = new AccessToken(livekitApiKey, livekitApiSecret, {
      identity,
      ttl: "2h"
    });
    token.roomConfig = new RoomConfiguration({
      name: roomName,
      agents: [
        new RoomAgentDispatch({
          agentName: transcriberAgentName,
          metadata: transcriberDispatchMetadata(identity)
        })
      ]
    });
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    await ensureTranscriberDispatch(roomName, identity);

    res.json({ token: await token.toJwt() });
  } catch (error) {
    console.error("token_error", error);
    res.status(500).json({ error: "Could not create LiveKit token." });
  }
});

app.use(express.static(distDir));
app.get(["/", "/founder", "/prospect", "/zoom"], (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

function getCall(callId: string): CallState {
  if (!calls.has(callId)) {
    calls.set(callId, {
      transcript: [],
      facts: [],
      gaps: new Set(defaultOpenGaps),
      analysis: defaultAnalysis,
      pitchDrift: defaultPitchDrift,
      lastAnalysisAt: 0,
      lastPitchDriftAt: 0
    });
  }

  return calls.get(callId) as CallState;
}

function updateCallState(call: CallState, turn: TranscriptTurn) {
  call.transcript.push(turn);
  call.transcript = call.transcript.slice(-40);
}

function isQuestionPriority(value: unknown): value is NextQuestion["priority"] {
  return value === "low" || value === "medium" || value === "high";
}

function isDiscoveryStage(value: unknown): value is DiscoveryStage {
  return typeof value === "string" && discoveryStages.includes(value as DiscoveryStage);
}

function parseNextQuestion(value: unknown): NextQuestion | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    isQuestionPriority(record.priority) &&
    typeof record.question === "string" &&
    typeof record.reason === "string"
  ) {
    return {
      priority: record.priority,
      question: record.question,
      reason: record.reason
    };
  }

  return null;
}

function parseCopilotAnalysis(value: unknown): CopilotAnalysis {
  if (!value || typeof value !== "object") return defaultAnalysis;

  const record = value as Record<string, unknown>;
  const stage = isDiscoveryStage(record.stage) ? record.stage : defaultAnalysis.stage;
  const nextQuestions = Array.isArray(record.nextQuestions)
    ? record.nextQuestions.map(parseNextQuestion).filter((question): question is NextQuestion => Boolean(question)).slice(0, 2)
    : [];

  return {
    stage,
    nextQuestions: nextQuestions.length ? nextQuestions : defaultAnalysis.nextQuestions
  };
}

function isPitchDriftState(value: unknown): value is PitchDriftState {
  return value === "on_discovery_path" || value === "drifting" || value === "pitching" || value === "recovering";
}

function clampConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function parsePitchDriftAnalysis(value: unknown): PitchDriftAnalysis {
  if (!value || typeof value !== "object") return defaultPitchDrift;

  const record = value as Record<string, unknown>;
  const state = isPitchDriftState(record.state) ? record.state : defaultPitchDrift.state;
  const reasons = Array.isArray(record.reasons)
    ? record.reasons
        .filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0)
        .map((reason) => reason.trim())
        .slice(0, 3)
    : [];
  const warning = typeof record.warning === "string" ? record.warning.trim() : "";
  const recoveryQuestion = typeof record.recoveryQuestion === "string" ? record.recoveryQuestion.trim() : "";
  const shouldWarn =
    (state === "drifting" || state === "pitching") &&
    (typeof record.shouldWarn === "boolean" ? record.shouldWarn : true);

  return {
    state,
    confidence: clampConfidence(record.confidence),
    shouldWarn,
    warning: shouldWarn && warning ? warning : "",
    recoveryQuestion: recoveryQuestion || defaultPitchDrift.recoveryQuestion,
    reasons
  };
}

function parseLlmAnalysis(value: unknown): LlmAnalysis {
  const analysis = parseCopilotAnalysis(value);
  if (!value || typeof value !== "object") {
    return { ...analysis, facts: [], completedGaps: [] };
  }

  const record = value as Record<string, unknown>;
  const facts = Array.isArray(record.facts)
    ? record.facts.filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0).map((fact) => fact.trim()).slice(0, 8)
    : [];
  const completedGaps = Array.isArray(record.completedGaps)
    ? record.completedGaps.filter((gap): gap is string => typeof gap === "string" && defaultOpenGaps.includes(gap)).slice(0, defaultOpenGaps.length)
    : [];

  return {
    ...analysis,
    facts,
    completedGaps
  };
}

function applyLlmCallState(call: CallState, llmAnalysis: LlmAnalysis) {
  for (const fact of llmAnalysis.facts) {
    if (!call.facts.includes(fact)) {
      call.facts.push(fact);
    }
  }

  for (const gap of llmAnalysis.completedGaps) {
    call.gaps.delete(gap);
  }

  call.facts = call.facts.slice(-8);
}

function copilotError(callId: string, error: unknown): CopilotError {
  return {
    type: "copilot.error",
    callId,
    error: error instanceof Error ? error.message : "OpenAI co-pilot analysis failed."
  };
}

function truncateForPrompt(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}...` : text;
}

function getNextDiscoveryStage(currentStage: DiscoveryStage) {
  const currentIndex = discoveryStageGuide.findIndex((entry) => entry.stage === currentStage);
  const nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, discoveryStageGuide.length - 1);
  return discoveryStageGuide[nextIndex];
}

function buildMossQuery(call: CallState) {
  const nextStage = getNextDiscoveryStage(call.analysis.stage);
  const recentTranscript = call.transcript
    .slice(-12)
    .map((turn) => `${turn.speaker}: ${turn.text}`)
    .join("\n");

  return [
    `Current discovery stage: ${call.analysis.stage}`,
    `Next likely discovery stage: ${nextStage.stage}`,
    `Next stage goal: ${nextStage.goal}`,
    `Next stage done when: ${nextStage.doneWhen}`,
    call.facts.length ? `Known facts:\n${call.facts.slice(-8).join("\n")}` : undefined,
    call.gaps.size ? `Open gaps: ${[...call.gaps].join(", ")}` : undefined,
    `Recent transcript:\n${recentTranscript}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function loadMossIndexIfNeeded() {
  if (!moss || !mossIndexName || !mossShouldLoadIndex) return;

  mossLoadPromise ??= moss
    .loadIndex(mossIndexName, {
      autoRefresh: mossAutoRefresh,
      pollingIntervalInSeconds: mossPollingIntervalInSeconds,
      ...(mossCachePath ? { cachePath: mossCachePath } : {})
    })
    .catch((error) => {
      mossLoadPromise = undefined;
      throw error;
    });

  await mossLoadPromise;
}

function formatMossSnippets(docs: QueryResultDocumentInfo[]): MossContextSnippet[] {
  return docs
    .filter((doc) => doc.score >= mossMinScore)
    .slice(0, Number.isFinite(mossTopK) && mossTopK > 0 ? mossTopK : 5)
    .map((doc) => ({
      id: doc.id,
      score: doc.score,
      metadata: doc.metadata,
      text: truncateForPrompt(doc.text, 1_500)
    }));
}

async function retrieveMossContext(call: CallState): Promise<MossContextSnippet[]> {
  if (!moss || !mossIndexName || !call.transcript.length) return [];

  try {
    await loadMossIndexIfNeeded();
    const query = buildMossQuery(call);
    const results = await moss.query(mossIndexName, query, {
      topK: Number.isFinite(mossTopK) && mossTopK > 0 ? mossTopK : 5
    });

    const snippets = formatMossSnippets(results.docs);
    console.info("moss_context_retrieved", {
      index: mossIndexName,
      query: truncateForPrompt(query, 500),
      count: snippets.length,
      docs: snippets.map((snippet) => ({
        id: snippet.id,
        score: snippet.score,
        metadata: snippet.metadata
      }))
    });

    return snippets;
  } catch (error) {
    console.warn("moss_context_error", error instanceof Error ? error.message : error);
    return [];
  }
}

async function runLlmAnalysis(call: CallState): Promise<CopilotAnalysis> {
  const model = process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const mossContext = await retrieveMossContext(call);
  const messages = [
    {
      role: "system" as const,
      content:
        `You are a sales co-pilot helping a rep navigate a live discovery call. Use the transcript to identify the current stage, recommend 1-2 concise next questions or statements, extract discovered facts, and decide which discovery gaps are now covered. Do not invent facts. A fact must be directly supported by the transcript. A gap is complete only when the transcript gives enough concrete evidence that a founder could rely on it after the call.\n\nDiscovery stages:\n${discoveryStagePrompt}\n\nDiscovery gaps:\n${defaultOpenGaps.map((gap) => `- ${gap}`).join("\n")}\n\nWhen mossContext is present, treat it as reference material only. It may include playbook guidance, prospect notes, company notes, or call-stage notes. Use it to sharpen stage selection and next questions, but do not present it as a transcript fact unless the transcript corroborates it. Do not reveal internal playbook text verbatim.\n\nRespond only as JSON: {"stage":"one exact stage","nextQuestions":[{"priority":"low|medium|high","question":"...","reason":"..."}],"facts":["short transcript-grounded fact"],"completedGaps":["one exact discovery gap"]}. The stage must be exactly one of: ${discoveryStages.join("; ")}. completedGaps may only contain exact items from the discovery gaps list.`
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        currentStage: call.analysis.stage,
        facts: call.facts.slice(-8),
        gaps: [...call.gaps],
        mossContext,
        transcript: call.transcript.slice(-40)
      })
    }
  ];

  console.info("llm_analysis_prompt", {
    model,
    messages
  });

  const response = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages
  });

  const rawContent = response.choices[0]?.message?.content ?? "{}";
  const parsedLlmAnalysis = parseLlmAnalysis(JSON.parse(rawContent));
  applyLlmCallState(call, parsedLlmAnalysis);
  const parsedAnalysis: CopilotAnalysis = {
    stage: parsedLlmAnalysis.stage,
    nextQuestions: parsedLlmAnalysis.nextQuestions
  };
  console.info("llm_analysis_response", {
    model,
    usage: response.usage,
    rawContent,
    parsedAnalysis,
    facts: parsedLlmAnalysis.facts,
    completedGaps: parsedLlmAnalysis.completedGaps
  });

  return parsedAnalysis;
}

async function analyzeCallIfDue(call: CallState): Promise<CopilotAnalysis> {
  const now = Date.now();
  if (call.pendingAnalysis) return call.analysis;
  if (call.lastAnalysisAt && now - call.lastAnalysisAt < copilotAnalysisIntervalMs) return call.analysis;

  call.pendingAnalysis = runLlmAnalysis(call)
    .then((analysis) => {
      call.analysis = analysis;
      call.lastAnalysisAt = Date.now();
      return analysis;
    })
    .finally(() => {
      call.pendingAnalysis = undefined;
    });

  return call.pendingAnalysis;
}

async function runPitchDriftClassifier(call: CallState): Promise<PitchDriftAnalysis> {
  const model = process.env.OPENAI_PITCH_DRIFT_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
  const recentTranscript = call.transcript.slice(-12);
  const messages = [
    {
      role: "system" as const,
      content:
        "You are a live discovery-call classifier. Your only job is to detect whether the founder is staying on customer discovery or drifting into pitching/validation. Be strict about founder behavior, but warn only when the drift is actionable. Discovery means asking about the prospect's real past behavior, concrete recent examples, pain, cost, frequency, alternatives, workaround spend, urgency, and next commitment. Pitching means explaining the product, proposing a solution, asking hypothetical/future-tense validation questions, accepting vague positive feedback, defending differentiation, demoing too early, or talking too much. Recovery means the founder recently redirected back to a concrete past example after drifting.\n\nRespond only as JSON: {\"state\":\"on_discovery_path|drifting|pitching|recovering\",\"confidence\":0.0,\"shouldWarn\":true,\"warning\":\"one short gentle warning\",\"recoveryQuestion\":\"one concise discovery question\",\"reasons\":[\"short reason\"]}. Warnings should be specific and actionable, never scolding. Prefer a recovery question that asks for the last real instance or existing workaround."
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        currentDiscoveryStage: call.analysis.stage,
        openGaps: [...call.gaps],
        transcript: recentTranscript
      })
    }
  ];

  console.info("pitch_drift_prompt", {
    model,
    messages
  });

  const response = await openai.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages
  });

  const rawContent = response.choices[0]?.message?.content ?? "{}";
  const parsedPitchDrift = parsePitchDriftAnalysis(JSON.parse(rawContent));
  console.info("pitch_drift_response", {
    model,
    usage: response.usage,
    rawContent,
    parsedPitchDrift
  });

  return parsedPitchDrift;
}

async function analyzePitchDriftIfDue(call: CallState, turn: TranscriptTurn): Promise<PitchDriftAnalysis> {
  const now = Date.now();
  if (call.pendingPitchDrift) return call.pitchDrift;
  if (turn.speaker !== "rep") return call.pitchDrift;
  if (call.lastPitchDriftAt && now - call.lastPitchDriftAt < pitchDriftIntervalMs) return call.pitchDrift;

  call.pendingPitchDrift = runPitchDriftClassifier(call)
    .then((pitchDrift) => {
      call.pitchDrift = pitchDrift;
      call.lastPitchDriftAt = Date.now();
      return pitchDrift;
    })
    .finally(() => {
      call.pendingPitchDrift = undefined;
    });

  return call.pendingPitchDrift;
}

function parseClientMessage(raw: RawData): TranscriptEvent | SubscribeEvent | null {
  const value = JSON.parse(raw.toString()) as unknown;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (record.type === "call.subscribe") {
    const callId = asNonEmptyString(record.callId);
    return callId ? { type: "call.subscribe", callId } : null;
  }

  if (record.type !== "transcript.turn") return null;

  const callId = asNonEmptyString(record.callId);
  const text = asNonEmptyString(record.text);
  const speaker = record.speaker;
  if (!callId || !text || (speaker !== "rep" && speaker !== "prospect")) return null;

  return {
    type: "transcript.turn",
    callId,
    speaker,
    text,
    id: typeof record.id === "string" ? record.id : undefined,
    final: typeof record.final === "boolean" ? record.final : undefined,
    timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined
  };
}

function subscribeSocketToCall(socket: WebSocket, callId: string) {
  const subscribers = callSubscribers.get(callId) ?? new Set<WebSocket>();
  subscribers.add(socket);
  callSubscribers.set(callId, subscribers);
}

function unsubscribeSocket(socket: WebSocket) {
  callSubscribers.forEach((subscribers, callId) => {
    subscribers.delete(socket);
    if (subscribers.size === 0) {
      callSubscribers.delete(callId);
    }
  });
}

function sendToCallSubscribers(callId: string, payload: unknown) {
  const message = JSON.stringify(payload);
  callSubscribers.get(callId)?.forEach((subscriber) => {
    if (subscriber.readyState === WebSocket.OPEN) {
      subscriber.send(message);
    }
  });
}

async function ingestTranscriptTurn(callId: string, body: TranscriptIngestRequest) {
  const text = asNonEmptyString(body.text);
  const speaker = body.speaker;
  if (!text || (speaker !== "rep" && speaker !== "prospect")) {
    return null;
  }

  const call = getCall(callId);
  const turn: TranscriptTurn = {
    id: body.id ?? randomUUID(),
    speaker,
    text,
    final: body.final ?? true,
    timestamp: body.timestamp ?? new Date().toISOString()
  };

  updateCallState(call, turn);
  const [analysis, pitchDrift] = await Promise.all([analyzeCallIfDue(call), analyzePitchDriftIfDue(call, turn)]);
  const payload = {
    type: "copilot.update",
    callId,
    analysis,
    pitchDrift,
    state: {
      stage: analysis.stage,
      facts: call.facts,
      gaps: [...call.gaps]
    }
  };
  sendToCallSubscribers(callId, payload);

  return { turn, payload };
}

async function ingestZoomTranscript(callId: string, streamId: string, text: string, timestamp: number, userName?: string, userId?: number) {
  return ingestTranscriptTurn(callId, {
    id: `${streamId}:${userId ?? "unknown"}:${timestamp}:${text.length}`,
    speaker: speakerFromZoomName(userName),
    text,
    final: true,
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : new Date().toISOString()
  });
}

function leaveZoomRtmsClient(streamId: string) {
  const client = zoomRtmsClients.get(streamId);
  if (!client) return;

  try {
    client.leave();
  } catch (error) {
    console.warn("zoom_rtms_leave_error", error instanceof Error ? error.message : error);
  } finally {
    zoomRtmsClients.delete(streamId);
  }
}

function handleZoomRtmsStarted(payload: Record<string, unknown>) {
  const streamId = asNonEmptyString(payload.rtms_stream_id);
  const serverUrls = asNonEmptyString(payload.server_urls);
  const callId = zoomCallIdFromPayload(payload);

  if (!streamId || !serverUrls || !callId) {
    console.warn("zoom_rtms_missing_payload", { streamId: Boolean(streamId), serverUrls: Boolean(serverUrls), callId });
    return;
  }

  leaveZoomRtmsClient(streamId);

  const client = new rtms.Client();
  zoomRtmsClients.set(streamId, client);

  client.onTranscriptData((buffer, _size, timestamp, metadata) => {
    const text = buffer.toString("utf8").trim();
    if (!text) return;

    ingestZoomTranscript(callId, streamId, text, timestamp, metadata.userName, metadata.userId).catch((error) => {
      console.error("zoom_rtms_transcript_error", error);
      sendToCallSubscribers(callId, copilotError(callId, error));
    });
  });

  client.onLeave((reason) => {
    zoomRtmsClients.delete(streamId);
    console.info("zoom_rtms_left", { streamId, reason });
  });

  client.join({
    meeting_uuid: asNonEmptyString(payload.meeting_uuid),
    webinar_uuid: asNonEmptyString(payload.webinar_uuid),
    session_id: asNonEmptyString(payload.session_id),
    engagement_id: asNonEmptyString(payload.engagement_id),
    rtms_stream_id: streamId,
    server_urls: serverUrls,
    pollInterval: Number(process.env.ZOOM_RTMS_POLL_INTERVAL_MS ?? 20)
  });

  console.info("zoom_rtms_joined", { callId, streamId });
}

function handleZoomRtmsWebhook(body: Record<string, unknown>) {
  const event = asNonEmptyString(body.event);
  const payload = body.payload && typeof body.payload === "object" ? (body.payload as Record<string, unknown>) : {};
  const streamId = asNonEmptyString(payload.rtms_stream_id);

  if (event === "endpoint.url_validation") {
    const plainToken = asNonEmptyString(payload.plainToken);
    const encryptedToken = plainToken ? zoomEncryptedToken(plainToken) : undefined;
    return plainToken && encryptedToken ? { type: "validation" as const, plainToken, encryptedToken } : { type: "invalid" as const };
  }

  if (event === "meeting.rtms_started" || event === "webinar.rtms_started" || event === "session.rtms_started") {
    handleZoomRtmsStarted(payload);
    return { type: "ok" as const };
  }

  if (event === "meeting.rtms_stopped" || event === "webinar.rtms_stopped" || event === "session.rtms_stopped") {
    if (streamId) leaveZoomRtmsClient(streamId);
    return { type: "ok" as const };
  }

  return { type: "ignored" as const, event };
}

app.post("/api/calls/:callId/transcript", async (req, res) => {
  try {
    if (zoomTranscriptIngestSecret && req.get("x-transcript-ingest-secret") !== zoomTranscriptIngestSecret) {
      return res.status(401).json({ error: "Invalid transcript ingest secret." });
    }

    const callId = asNonEmptyString(req.params.callId);
    if (!callId) return res.status(400).json({ error: "callId is required." });

    const result = await ingestTranscriptTurn(callId, req.body as TranscriptIngestRequest);
    if (!result) {
      return res.status(400).json({ error: "speaker and text are required." });
    }

    res.json({ ok: true, turn: result.turn });
  } catch (error) {
    console.error("transcript_ingest_error", error);
    res.status(500).json({ error: "Could not ingest transcript turn." });
  }
});

app.post("/zoom/rtms/webhook", (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const event = asNonEmptyString(body.event);
    if (event === "endpoint.url_validation") {
      const result = handleZoomRtmsWebhook(body);
      if (result.type === "validation") {
        return res.json({
          plainToken: result.plainToken,
          encryptedToken: result.encryptedToken
        });
      }

      return res.status(400).json({ error: "Invalid Zoom URL validation payload." });
    }

    if (!verifyZoomWebhookSignature(req)) {
      return res.status(401).json({ error: "Invalid Zoom webhook signature." });
    }

    const result = handleZoomRtmsWebhook(body);
    res.json({ ok: true, status: result.type });
  } catch (error) {
    console.error("zoom_rtms_webhook_error", error);
    res.status(500).json({ error: "Could not process Zoom RTMS webhook." });
  }
});

wss.on("connection", (socket) => {
  socket.on("close", () => unsubscribeSocket(socket));
  socket.on("message", async (raw) => {
    try {
      const event = parseClientMessage(raw);
      if (!event) return;
      subscribeSocketToCall(socket, event.callId);
      if (event.type === "call.subscribe") return;

      try {
        await ingestTranscriptTurn(event.callId, event);
      } catch (error) {
        console.error("openai_analysis_error", error);
        sendToCallSubscribers(event.callId, copilotError(event.callId, error));
      }
    } catch (error) {
      console.error("ws_error", error);
      socket.send(JSON.stringify({ type: "error", error: "Could not process transcript turn." }));
    }
  });
});

server.listen(port, host, () => {
  console.log(`Discovery co-pilot listening on http://${host}:${port}`);
});
