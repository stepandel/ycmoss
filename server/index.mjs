import "dotenv/config";
import express from "express";
import http from "node:http";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { AccessToken } from "livekit-server-sdk";

const port = Number(process.env.PORT ?? 8787);
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(express.json());

app.get("/api/config", (_req, res) => {
  res.json({
    livekitUrl: process.env.LIVEKIT_URL ?? "",
    hasLiveKitCredentials: Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET),
    suggestionMode: openai ? "openai" : "local"
  });
});

app.post("/api/livekit/token", async (req, res) => {
  try {
    const { roomName, identity } = req.body ?? {};
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      return res.status(400).json({ error: "LiveKit credentials are not configured." });
    }
    if (!roomName || !identity) {
      return res.status(400).json({ error: "roomName and identity are required." });
    }

    const token = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity,
      ttl: "2h"
    });
    token.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    res.json({ token: await token.toJwt() });
  } catch (error) {
    console.error("token_error", error);
    res.status(500).json({ error: "Could not create LiveKit token." });
  }
});

const calls = new Map();

function getCall(callId) {
  if (!calls.has(callId)) {
    calls.set(callId, {
      transcript: [],
      facts: [],
      gaps: new Set(["business impact", "decision process", "timeline", "success criteria"]),
      stage: "opening",
      lastSuggestionAt: 0
    });
  }
  return calls.get(callId);
}

function updateCallState(call, turn) {
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

function localSuggestion(call, turn) {
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

async function llmSuggestion(call, turn) {
  if (!openai) {
    return localSuggestion(call, turn);
  }

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

  try {
    return JSON.parse(response.choices[0]?.message?.content ?? "{\"type\":\"none\"}");
  } catch {
    return { type: "none" };
  }
}

wss.on("connection", (socket) => {
  socket.on("message", async (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (event.type !== "transcript.turn") return;

      const call = getCall(event.callId);
      const turn = {
        id: event.id ?? crypto.randomUUID(),
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

server.listen(port, () => {
  console.log(`Discovery co-pilot API listening on http://127.0.0.1:${port}`);
});
