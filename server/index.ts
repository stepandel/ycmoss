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

type Suggestion =
  | { type: "none" }
  | {
      type: "suggestion";
      priority: "low" | "medium" | "high";
      question: string;
      reason: string;
    };

type CallState = {
  transcript: TranscriptTurn[];
  facts: string[];
  gaps: Set<string>;
  stage: string;
  lastSuggestionAt: number;
};

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
const transcriberAgentName = process.env.LIVEKIT_TRANSCRIBER_AGENT_NAME ?? "transcriber";
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
      stage: "opening",
      lastSuggestionAt: 0
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
  if (text.includes("problem") || text.includes("hard") || text.includes("hate") || text.includes("struggle") || text.includes("slow")) {
    call.stage = "pain_discovery";
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

function localSuggestion(call: CallState, turn: TranscriptTurn): Suggestion {
  const text = turn.text.toLowerCase();
  if (turn.speaker !== "prospect" || turn.text.trim().length < 18) {
    return { type: "none" };
  }
  if (Date.now() - call.lastSuggestionAt < 1_500) {
    return { type: "none" };
  }

  const painWords = ["hard", "problem", "hate", "struggle", "manual", "slow", "miss", "messy", "expensive"];
  if (call.gaps.has("business impact") && painWords.some((word) => text.includes(word))) {
    return {
      type: "suggestion",
      priority: "high",
      question: "What is that costing the team today in time, pipeline, or missed revenue?",
      reason: "The prospect described pain, but the business impact is still unclear."
    };
  }
  if (text.includes("using") || text.includes("currently") || text.includes("we use")) {
    return {
      type: "suggestion",
      priority: "medium",
      question: "What made you start looking beyond the way you handle this today?",
      reason: "They shared the current workflow, so the next useful thread is motivation to change."
    };
  }
  if ([...call.gaps].includes("decision process") && (text.includes("team") || text.includes("manager") || text.includes("vp"))) {
    return {
      type: "suggestion",
      priority: "medium",
      question: "Who else usually weighs in when your team decides to change a workflow like this?",
      reason: "There may be a buying committee, and the decision process has not been mapped."
    };
  }
  return { type: "none" };
}

function isSuggestionPriority(value: unknown): value is Suggestion extends { type: "suggestion"; priority: infer Priority } ? Priority : never {
  return value === "low" || value === "medium" || value === "high";
}

function parseSuggestion(value: unknown): Suggestion {
  if (!value || typeof value !== "object") return { type: "none" };

  const record = value as Record<string, unknown>;
  if (record.type === "none") return { type: "none" };
  if (
    record.type === "suggestion" &&
    isSuggestionPriority(record.priority) &&
    typeof record.question === "string" &&
    typeof record.reason === "string"
  ) {
    return {
      type: "suggestion",
      priority: record.priority,
      question: record.question,
      reason: record.reason
    };
  }

  return { type: "none" };
}

async function llmSuggestion(call: CallState, turn: TranscriptTurn): Promise<Suggestion> {
  if (!openai) {
    return localSuggestion(call, turn);
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
            "You are a restrained sales discovery co-pilot. Suggest one concise next question only when it helps the rep. Otherwise return none. Respond as JSON: {\"type\":\"suggestion\",\"priority\":\"low|medium|high\",\"question\":\"...\",\"reason\":\"...\"} or {\"type\":\"none\"}."
        },
        {
          role: "user",
          content: JSON.stringify({
            stage: call.stage,
            facts: call.facts,
            gaps: [...call.gaps],
            recentTranscript: call.transcript.slice(-10),
            latestTurn: turn
          })
        }
      ]
    });

    return parseSuggestion(JSON.parse(response.choices[0]?.message?.content ?? "{\"type\":\"none\"}"));
  } catch (error) {
    console.warn("openai_suggestion_fallback", error instanceof Error ? error.message : error);
    return localSuggestion(call, turn);
  }
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
      const suggestion = await llmSuggestion(call, turn);
      if (suggestion.type === "suggestion") {
        call.lastSuggestionAt = Date.now();
      }

      socket.send(JSON.stringify({
        type: "copilot.update",
        callId: event.callId,
        suggestion,
        state: {
          stage: call.stage,
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
