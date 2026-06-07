import { useEffect, useMemo, useRef, useState } from "react";
import {
  ControlBar,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  useTranscriptions,
  useTracks
} from "@livekit/components-react";
import { Track } from "livekit-client";
import {
  BadgeCheck,
  Bot,
  Check,
  CircleAlert,
  CircleDot,
  Copy,
  Mic,
  Phone,
  Play,
  Send,
  Sparkles,
  UserRound,
  Users,
} from "lucide-react";

type Speaker = "rep" | "prospect";

type TranscriptTurn = {
  id: string;
  speaker: Speaker;
  text: string;
  timestamp: string;
  final: boolean;
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
  stage: string;
  facts: string[];
  gaps: string[];
};

type Config = {
  livekitUrl: string;
  suggestionMode: "openai" | "local";
};

type RouteMode = "founder" | "prospect";

const demoTurns: Array<Pick<TranscriptTurn, "speaker" | "text">> = [
  {
    speaker: "prospect",
    text: "We are currently using Salesforce, but our reps hate updating it after calls."
  },
  {
    speaker: "rep",
    text: "That makes sense. What happens when those updates are missing?"
  },
  {
    speaker: "prospect",
    text: "Forecast meetings get messy and managers spend hours chasing notes manually."
  },
  {
    speaker: "prospect",
    text: "The VP of Sales wants this fixed before next quarter planning."
  }
];

function getRouteMode(): RouteMode {
  if (window.location.pathname.startsWith("/prospect")) return "prospect";
  return "founder";
}

function getWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const isViteDevServer = window.location.hostname === "127.0.0.1" && window.location.port === "5173";
  const host = isViteDevServer ? "127.0.0.1:8787" : window.location.host;
  return `${protocol}://${host}/ws`;
}

function VideoGrid() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false }
    ],
    { onlySubscribed: false }
  );

  return (
    <GridLayout tracks={tracks} className="video-grid">
      <ParticipantTile />
    </GridLayout>
  );
}

function speakerFromIdentity(identity: string): Speaker {
  return identity.toLowerCase().includes("founder") || identity.toLowerCase().includes("rep") ? "rep" : "prospect";
}

type LiveTranscriptionBridgeProps = {
  onTranscript: (turn: TranscriptTurn) => void;
};

function LiveTranscriptionBridge({ onTranscript }: LiveTranscriptionBridgeProps) {
  const transcriptions = useTranscriptions();

  useEffect(() => {
    transcriptions.forEach((transcription) => {
      const segmentId = transcription.streamInfo.attributes?.["lk.segment_id"] ?? transcription.streamInfo.id;
      const isFinal = transcription.streamInfo.attributes?.["lk.transcription_final"] === "true";
      const text = transcription.text.trim();
      if (!text) return;

      onTranscript({
        id: segmentId,
        speaker: speakerFromIdentity(transcription.participantInfo.identity),
        text,
        timestamp: new Date().toISOString(),
        final: isFinal
      });
    });
  }, [onTranscript, transcriptions]);

  return null;
}

export function App() {
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const routeMode = useMemo(getRouteMode, []);
  const initialRoomName = initialParams.get("room") ?? "discovery-demo";
  const initialIdentity =
    initialParams.get("identity") ?? `${routeMode}-${Math.floor(Math.random() * 9000) + 1000}`;
  const [config, setConfig] = useState<Config | null>(null);
  const [identity, setIdentity] = useState(initialIdentity);
  const [roomName, setRoomName] = useState(initialRoomName);
  const [token, setToken] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [speaker, setSpeaker] = useState<Speaker>("prospect");
  const [draft, setDraft] = useState("");
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [suggestion, setSuggestion] = useState<Suggestion>({ type: "none" });
  const [callState, setCallState] = useState<CallState>({
    stage: "opening",
    facts: [],
    gaps: ["business impact", "decision process", "timeline", "success criteria"]
  });
  const [connectionState, setConnectionState] = useState("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const sentLiveTranscriptIdsRef = useRef<Set<string>>(new Set());
  const callId = roomName;

  useEffect(() => {
    fetch("/api/config")
      .then((response) => response.json())
      .then(setConfig);
  }, []);

  useEffect(() => {
    if (window.location.pathname === "/") {
      window.history.replaceState(null, "", `/founder${window.location.search}`);
    }

    const socket = new WebSocket(getWebSocketUrl());
    wsRef.current = socket;
    socket.addEventListener("open", () => setConnectionState("connected"));
    socket.addEventListener("close", () => setConnectionState("disconnected"));
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(message.data);
      if (event.type === "copilot.update") {
        if (event.suggestion.type === "suggestion") {
          setSuggestion(event.suggestion);
        }
        setCallState(event.state);
      }
    });
    return () => socket.close();
  }, []);

  async function joinRoom() {
    setIsJoining(true);
    try {
      const response = await fetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomName, identity })
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not join room.");
      setToken(payload.token);
    } catch (error) {
      setSuggestion({
        type: "suggestion",
        priority: "low",
        question: "LiveKit could not create a room token. Check the server logs, then try joining again.",
        reason: error instanceof Error ? error.message : "Could not join the LiveKit room."
      });
    } finally {
      setIsJoining(false);
    }
  }

  function sendTurn(text = draft, nextSpeaker = speaker) {
    const cleanText = text.trim();
    if (!cleanText || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const turn: TranscriptTurn = {
      id: crypto.randomUUID(),
      speaker: nextSpeaker,
      text: cleanText,
      timestamp: new Date().toISOString(),
      final: true
    };

    setTranscript((current) => [...current, turn]);
    wsRef.current.send(JSON.stringify({ type: "transcript.turn", callId, ...turn, final: true }));
    setDraft("");
  }

  const handleLiveTranscript = useMemo(
    () => (turn: TranscriptTurn) => {
      setTranscript((current) => {
        const existingIndex = current.findIndex((item) => item.id === turn.id);
        if (existingIndex === -1) return [...current, turn];

        const next = [...current];
        next[existingIndex] = { ...next[existingIndex], ...turn };
        return next;
      });

      if (!turn.final || sentLiveTranscriptIdsRef.current.has(turn.id)) return;
      sentLiveTranscriptIdsRef.current.add(turn.id);
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "transcript.turn", callId, ...turn }));
      }
    },
    [callId]
  );

  function runDemo() {
    demoTurns.forEach((turn, index) => {
      window.setTimeout(() => sendTurn(turn.text, turn.speaker), index * 900);
    });
  }

  const isFounder = routeMode === "founder";
  const isLiveKitReady = Boolean(config?.livekitUrl && token);
  const founderLink = `${window.location.origin}/founder?room=${encodeURIComponent(roomName)}&identity=${encodeURIComponent("founder")}`;
  const prospectLink = `${window.location.origin}/prospect?room=${encodeURIComponent(roomName)}&identity=${encodeURIComponent("prospect")}`;

  async function copyLink(link: string) {
    await navigator.clipboard.writeText(link);
  }

  return (
    <main className={`shell ${routeMode}`}>
      <section className="call-panel">
        <header className="topbar">
          <div>
            <h1>{isFounder ? "Founder Co-Pilot" : "Discovery Call"}</h1>
            <p>
              {isFounder
                ? "Live call, live transcript, restrained next-question suggestions."
                : "Join the same discovery room without the internal co-pilot workspace."}
            </p>
          </div>
          <div className="status-row">
            <span className={`status-pill ${connectionState}`}>
              <CircleDot size={14} />
              {connectionState}
            </span>
            {isFounder ? (
              <span className="status-pill">
                <Sparkles size={14} />
                {config?.suggestionMode ?? "local"} suggestions
              </span>
            ) : null}
            <span className="status-pill">
              <Users size={14} />
              shared room
            </span>
          </div>
        </header>

        <section className="video-stage">
          {isLiveKitReady && config ? (
            <LiveKitRoom
              serverUrl={config.livekitUrl}
              token={token}
              connect
              video
              audio
              className="livekit-room"
            >
              <LiveTranscriptionBridge onTranscript={handleLiveTranscript} />
              <VideoGrid />
              <RoomAudioRenderer />
              <ControlBar />
            </LiveKitRoom>
          ) : (
            <div className="empty-video">
              <div>
                <h2>LiveKit room</h2>
                <p>Join the room to start video.</p>
              </div>
            </div>
          )}
        </section>

        <section className="join-strip">
          <label>
            Room
            <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
          </label>
          <label>
            Identity
            <input value={identity} onChange={(event) => setIdentity(event.target.value)} />
          </label>
          <button className="primary-button" onClick={joinRoom} disabled={isJoining}>
            <Phone size={17} />
            {token ? "Rejoin" : "Join"}
          </button>
        </section>

        <section className="invite-strip">
          <div>
            <span>Founder</span>
            <code>{founderLink}</code>
            <button className="icon-button" onClick={() => copyLink(founderLink)} aria-label="Copy founder link">
              <Copy size={17} />
            </button>
          </div>
          <div>
            <span>Prospect</span>
            <code>{prospectLink}</code>
            <button className="icon-button" onClick={() => copyLink(prospectLink)} aria-label="Copy prospect link">
              <Copy size={17} />
            </button>
          </div>
        </section>

        {isFounder ? (
          <section className="transcript-panel">
            <div className="section-title">
              <Mic size={18} />
              <h2>Transcript Stream</h2>
            </div>
            <div className="transcript-list">
              {transcript.length === 0 ? (
                <p className="muted">Live speech-to-text appears here during the room. You can still send a manual turn or run the demo.</p>
              ) : (
                transcript.map((turn) => (
                  <article key={turn.id} className={`turn ${turn.speaker}${turn.final ? "" : " interim"}`}>
                    <span>{turn.speaker === "rep" ? "Founder" : "Prospect"}</span>
                    <p>{turn.text}</p>
                  </article>
                ))
              )}
            </div>
            <div className="composer">
              <div className="segmented" role="tablist" aria-label="Speaker">
                <button className={speaker === "prospect" ? "active" : ""} onClick={() => setSpeaker("prospect")}>
                  <UserRound size={16} />
                  Prospect
                </button>
                <button className={speaker === "rep" ? "active" : ""} onClick={() => setSpeaker("rep")}>
                  <BadgeCheck size={16} />
                  Founder
                </button>
              </div>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") sendTurn();
                }}
                placeholder="Type a transcript turn..."
              />
              <button className="icon-button" onClick={() => sendTurn()} aria-label="Send transcript turn">
                <Send size={18} />
              </button>
              <button className="ghost-button" onClick={runDemo}>
                <Play size={16} />
                Demo
              </button>
            </div>
          </section>
        ) : null}
      </section>

      {isFounder ? (
        <aside className="copilot-panel">
          <div className="section-title">
            <Bot size={19} />
            <h2>Co-Pilot</h2>
          </div>

          <section className={`suggestion-card ${suggestion.type === "suggestion" ? suggestion.priority : "quiet"}`}>
            {suggestion.type === "suggestion" ? (
              <>
                <div className="priority">
                  <CircleAlert size={16} />
                  {suggestion.priority} priority
                </div>
                <h3>{suggestion.question}</h3>
                <p>{suggestion.reason}</p>
                <div className="actions">
                  <button className="primary-button">
                    <Check size={16} />
                    Use
                  </button>
                  <button className="ghost-button" onClick={() => setSuggestion({ type: "none" })}>
                    Dismiss
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="priority">
                  <Check size={16} />
                  Listening
                </div>
                <h3>No suggestion right now</h3>
                <p>The co-pilot is intentionally quiet until the transcript exposes a useful next question.</p>
              </>
            )}
          </section>

          <section className="state-panel">
            <h3>Call State</h3>
            <dl>
              <div>
                <dt>Stage</dt>
                <dd>{callState.stage.replace("_", " ")}</dd>
              </div>
              <div>
                <dt>Open gaps</dt>
                <dd>{callState.gaps.length ? callState.gaps.join(", ") : "covered"}</dd>
              </div>
            </dl>
          </section>

          <section className="facts-panel">
            <h3>Captured Facts</h3>
            {callState.facts.length ? (
              <ul>
                {callState.facts.map((fact, index) => (
                  <li key={`${fact}-${index}`}>{fact}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Facts appear here as the prospect describes their current workflow.</p>
            )}
          </section>
        </aside>
      ) : null}
    </main>
  );
}
