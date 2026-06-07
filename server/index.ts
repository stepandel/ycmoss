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

type DiscoveryStage =
  | "Remove idea from the table"
  | "Get them telling stories about the past"
  | "Mine for specific instance for cost consequence"
  | "Surface the behavioural residue"
  | "Check for active search"
  | "Introduce direction"
  | "Close by pining a concrete next step";

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

if (missingLiveKitEnv.length) {
  console.error(`Missing required LiveKit environment: ${missingLiveKitEnv.join(", ")}`);
  process.exit(1);
}

const livekitUrl = process.env.LIVEKIT_URL as string;
const livekitApiKey = process.env.LIVEKIT_API_KEY as string;
const livekitApiSecret = process.env.LIVEKIT_API_SECRET as string;
const livekitApiHost = livekitUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = [path.resolve(__dirname, "../dist"), path.resolve(__dirname, "../../dist")].find(existsSync) ?? path.resolve(__dirname, "../dist");
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const agentDispatchClient = new AgentDispatchClient(livekitApiHost, livekitApiKey, livekitApiSecret);
const calls = new Map<string, CallState>();
const discoveryStages = [
  "Remove idea from the table",
  "Get them telling stories about the past",
  "Mine for specific instance for cost consequence",
  "Surface the behavioural residue",
  "Check for active search",
  "Introduce direction",
  "Close by pining a concrete next step"
] as const satisfies readonly DiscoveryStage[];
const defaultAnalysis: CopilotAnalysis = {
  stage: "Get them telling stories about the past",
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
    livekitUrl,
    suggestionMode: openai ? "openai" : "local"
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

function localAnalysis(call: CallState): CopilotAnalysis {
  const recentTranscript = call.transcript.slice(-12);
  const prospectText = recentTranscript
    .filter((turn) => turn.speaker === "prospect")
    .map((turn) => turn.text.toLowerCase())
    .join(" ");

  if (!prospectText.trim()) return defaultAnalysis;

  if (prospectText.includes("tried") || prospectText.includes("workaround") || prospectText.includes("built") || prospectText.includes("paid")) {
    return {
      stage: "Check for active search",
      nextQuestions: [
        {
          priority: "high",
          question: "Are you actively looking for a better way to handle this right now?",
          reason: "They described prior attempts, so the next signal is whether there is active search."
        },
        {
          priority: "medium",
          question: "What made the options you tried fall short?",
          reason: "Understanding failed fixes exposes buying criteria and urgency."
        }
      ]
    };
  }

  if (prospectText.includes("hours") || prospectText.includes("cost") || prospectText.includes("revenue") || prospectText.includes("pipeline")) {
    return {
      stage: "Surface the behavioural residue",
      nextQuestions: [
        {
          priority: "high",
          question: "What have you tried to fix this?",
          reason: "Cost has been surfaced, so the next step is finding evidence of behavior."
        },
        {
          priority: "medium",
          question: "Are you using anything for it today, even a hacky workaround?",
          reason: "Workarounds reveal pain strong enough to create action."
        }
      ]
    };
  }

  const painWords = ["hard", "problem", "hate", "struggle", "manual", "slow", "miss", "messy", "expensive"];
  if (painWords.some((word) => prospectText.includes(word))) {
    return {
      stage: "Mine for specific instance for cost consequence",
      nextQuestions: [
        {
          priority: "high",
          question: "Walk me through the last time this happened, step by step.",
          reason: "The prospect described pain; a specific instance will make the cost concrete."
        },
        {
          priority: "medium",
          question: "How long did that take?",
          reason: "Time cost is often the easiest consequence to quantify."
        },
        {
          priority: "medium",
          question: "What happened as a result?",
          reason: "The rep needs consequence, not just inconvenience."
        }
      ]
    };
  }

  return {
    stage: "Get them telling stories about the past",
    nextQuestions: [
      {
        priority: "medium",
        question: "Can you tell me about the last time this showed up in a real call or workflow?",
        reason: "Past-tense stories are more reliable than speculative opinions."
      }
    ]
  };
}

async function runLlmAnalysis(call: CallState): Promise<CopilotAnalysis> {
  if (!openai) {
    return localAnalysis(call);
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `You are a sales co-pilot helping a rep navigate a live discovery call. Use the transcript to identify the current stage and recommend 1-3 concise next questions. Do not invent facts. Prefer questions that move the rep toward concrete past behavior, cost, consequence, active search, and a concrete next step. Respond only as JSON: {"stage":"one exact stage","nextQuestions":[{"priority":"low|medium|high","question":"...","reason":"..."}]}. The stage must be exactly one of: ${discoveryStages.join("; ")}.`
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
  } catch (error) {
    console.warn("openai_analysis_fallback", error instanceof Error ? error.message : error);
    return localAnalysis(call);
  }
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
      console.error("ws_error", error);
      socket.send(JSON.stringify({ type: "error", error: "Could not process transcript turn." }));
    }
  });
});

server.listen(port, host, () => {
  console.log(`Discovery co-pilot listening on http://${host}:${port}`);
});
