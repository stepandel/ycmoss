import "dotenv/config";
import express from "express";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { AccessToken, AgentDispatchClient, RoomAgentDispatch, RoomConfiguration } from "livekit-server-sdk";
import { WebSocketServer, type RawData } from "ws";

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

type CopilotError = {
  type: "copilot.error";
  callId: string;
  error: string;
};

type DiscoveryStage =
  | "Frame & Disarm"
  | "Find a problem & get into a story"
  | "Quantify the pain"
  | "Find the behavioural residue"
  | "Gauge intent / Active search"
  | "Test commitment"
  | "Close on the next step";

type NextQuestion = {
  priority: "low" | "medium" | "high";
  question: string;
  reason: string;
};

type CopilotAnalysis = {
  stage: DiscoveryStage;
  nextQuestions: NextQuestion[];
};

type CallState = {
  transcript: TranscriptTurn[];
  facts: string[];
  gaps: Set<string>;
  analysis: CopilotAnalysis;
  lastAnalysisAt: number;
  pendingAnalysis?: Promise<CopilotAnalysis>;
};

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const transcriberAgentName = process.env.LIVEKIT_TRANSCRIBER_AGENT_NAME ?? "transcriber";
const copilotAnalysisIntervalMs = Number(process.env.COPILOT_ANALYSIS_INTERVAL_MS ?? 10_000);
const requiredLiveKitEnv = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] as const;
const missingLiveKitEnv = requiredLiveKitEnv.filter((key) => !process.env[key]);
const requiredOpenAiEnv = ["OPENAI_API_KEY"] as const;
const missingOpenAiEnv = requiredOpenAiEnv.filter((key) => !process.env[key]);

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
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const openai = new OpenAI({ apiKey: openaiApiKey });
const agentDispatchClient = new AgentDispatchClient(livekitApiHost, livekitApiKey, livekitApiSecret);
const calls = new Map<string, CallState>();
const discoveryStageGuide = [
  {
    stage: "Frame & Disarm",
    goal: "Get your idea off the table.",
    doneWhen: "They are talking freely about their own world, not reaching for a pitch."
  },
  {
    stage: "Find a problem & get into a story",
    goal: "Pin them to a specific, recent instance.",
    doneWhen: "You are inside one concrete past event, not generalities."
  },
  {
    stage: "Quantify the pain",
    goal: "Establish cost, frequency, and downstream consequence of that instance.",
    doneWhen: "You can state how much it hurts and how often."
  },
  {
    stage: "Find the behavioural residue",
    goal: "Uncover what they have already tried, built, or paid for.",
    doneWhen: "You know whether real money or time has been spent."
  },
  {
    stage: "Gauge intent / Active search",
    goal: "Determine if they are solving this now or it is a someday item.",
    doneWhen: "You know it is a find-budget problem, not a nice-to-have."
  },
  {
    stage: "Test commitment",
    goal: "Float your direction lightly and ask for something costly: time, an intro, or money.",
    doneWhen: "They either advance or dodge."
  },
  {
    stage: "Close on the next step",
    goal: "Lock a concrete dated advancement, or explicitly name that there is not one.",
    doneWhen: "The next step, or its confirmed absence, is unambiguous."
  }
] as const satisfies ReadonlyArray<{ stage: DiscoveryStage; goal: string; doneWhen: string }>;
const discoveryStages = discoveryStageGuide.map((entry) => entry.stage);
const discoveryStagePrompt = discoveryStageGuide
  .map((entry, index) => `${index + 1}. ${entry.stage} — Goal: ${entry.goal} Done when: ${entry.doneWhen}`)
  .join("\n");
const defaultAnalysis: CopilotAnalysis = {
  stage: "Find a problem & get into a story",
  nextQuestions: [
    {
      priority: "medium",
      question: "Can you walk me through the last time this came up?",
      reason: "A concrete past story gives the rep better signal than abstract opinions."
    }
  ]
};

app.use(express.json());

app.get("/api/config", (_req, res) => {
  res.json({
    livekitUrl
  });
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
app.get(["/", "/founder", "/prospect"], (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

function getCall(callId: string): CallState {
  if (!calls.has(callId)) {
    calls.set(callId, {
      transcript: [],
      facts: [],
      gaps: new Set(["business impact", "decision process", "timeline", "success criteria"]),
      analysis: defaultAnalysis,
      lastAnalysisAt: 0
    });
  }

  return calls.get(callId) as CallState;
}

function updateCallState(call: CallState, turn: TranscriptTurn) {
  call.transcript.push(turn);
  call.transcript = call.transcript.slice(-40);

  const text = turn.text.toLowerCase();
  if (text.includes("using ") || text.includes("we use ") || text.includes("currently")) {
    call.facts.push(`Stack/status quo: ${turn.text}`);
  }
  if (text.includes("cost") || text.includes("revenue") || text.includes("hours") || text.includes("time") || text.includes("pipeline")) {
    call.gaps.delete("business impact");
  }
  if (text.includes("decide") || text.includes("approval") || text.includes("procurement")) {
    call.gaps.delete("decision process");
  }
  if (text.includes("this quarter") || text.includes("next month") || text.includes("timeline") || text.includes("by q")) {
    call.gaps.delete("timeline");
  }
  if (text.includes("success") || text.includes("metric") || text.includes("kpi")) {
    call.gaps.delete("success criteria");
  }

  call.facts = call.facts.slice(-8);
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
    ? record.nextQuestions.map(parseNextQuestion).filter((question): question is NextQuestion => Boolean(question)).slice(0, 3)
    : [];

  return {
    stage,
    nextQuestions: nextQuestions.length ? nextQuestions : defaultAnalysis.nextQuestions
  };
}

function copilotError(callId: string, error: unknown): CopilotError {
  return {
    type: "copilot.error",
    callId,
    error: error instanceof Error ? error.message : "OpenAI co-pilot analysis failed."
  };
}

async function runLlmAnalysis(call: CallState): Promise<CopilotAnalysis> {
  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You are a sales co-pilot helping a rep navigate a live discovery call. Use the transcript to identify the current stage and recommend 1-3 concise next questions. Do not invent facts. Prefer questions that move the rep toward concrete past behavior, cost, consequence, active search, commitment, and a concrete next step.\n\nDiscovery stages:\n${discoveryStagePrompt}\n\nRespond only as JSON: {"stage":"one exact stage","nextQuestions":[{"priority":"low|medium|high","question":"...","reason":"..."}]}. The stage must be exactly one of: ${discoveryStages.join("; ")}.`
      },
      {
        role: "user",
        content: JSON.stringify({
          currentStage: call.analysis.stage,
          facts: call.facts.slice(-8),
          gaps: [...call.gaps],
          transcript: call.transcript.slice(-40)
        })
      }
    ]
  });

  return parseCopilotAnalysis(JSON.parse(response.choices[0]?.message?.content ?? "{}"));
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

function parseTranscriptEvent(raw: RawData): TranscriptEvent | null {
  const value = JSON.parse(raw.toString()) as unknown;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
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

wss.on("connection", (socket) => {
  socket.on("message", async (raw) => {
    try {
      const event = parseTranscriptEvent(raw);
      if (!event) return;

      const call = getCall(event.callId);
      const turn: TranscriptTurn = {
        id: event.id ?? randomUUID(),
        speaker: event.speaker,
        text: event.text,
        final: event.final ?? true,
        timestamp: event.timestamp ?? new Date().toISOString()
      };

      updateCallState(call, turn);
      try {
        const analysis = await analyzeCallIfDue(call);
        socket.send(JSON.stringify({
          type: "copilot.update",
          callId: event.callId,
          analysis,
          state: {
            stage: analysis.stage,
            facts: call.facts,
            gaps: [...call.gaps]
          }
        }));
      } catch (error) {
        console.error("openai_analysis_error", error);
        socket.send(JSON.stringify(copilotError(event.callId, error)));
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
