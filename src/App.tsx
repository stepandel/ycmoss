import { useEffect, useMemo, useRef, useState } from "react";
import {
  ControlBar,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  TrackToggle,
  useTranscriptions,
  useTracks
} from "@livekit/components-react";
import { Track } from "livekit-client";
import {
  BadgeCheck,
  Check,
  CircleAlert,
  Copy,
  Mic,
  MicOff,
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
  stage: DiscoveryStage;
  facts: string[];
  gaps: string[];
};

type Config = {
  livekitUrl: string;
};

type RouteMode = "founder" | "prospect";

const discoveryArc: Array<{ stage: DiscoveryStage; label: string; goal: string }> = [
  {
    stage: "Frame & Disarm",
    label: "Frame & disarm",
    goal: "Get your idea off the table."
  },
  {
    stage: "Find a problem & get into a story",
    label: "Problem story",
    goal: "Pin them to a specific, recent instance."
  },
  {
    stage: "Quantify the pain",
    label: "Quantify pain",
    goal: "Establish cost, frequency, and downstream consequence of that instance."
  },
  {
    stage: "Find the behavioural residue",
    label: "Behavioural residue",
    goal: "Uncover what they have already tried, built, or paid for."
  },
  {
    stage: "Gauge intent / Active search",
    label: "Active search",
    goal: "Determine if they are solving this now or it is a someday item."
  },
  {
    stage: "Test commitment",
    label: "Test commitment",
    goal: "Float your direction lightly and ask for something costly: time, an intro, or money."
  },
  {
    stage: "Close on the next step",
    label: "Next step",
    goal: "Lock a concrete dated advancement, or explicitly name that there is not one."
  }
];

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

const defaultAnalysis: CopilotAnalysis = {
  stage: "Find a problem & get into a story",
  nextQuestions: []
};

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

function formatElapsed(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatClock(isoTimestamp: string) {
  return new Date(isoTimestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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

function MicMuteButton() {
  return (
    <div className="stage-mic-control">
      <TrackToggle
        className="mic-toggle"
        source={Track.Source.Microphone}
        showIcon={false}
        aria-label="Toggle microphone"
        title="Toggle microphone"
      >
        <span className="mic-toggle-on">
          <Mic size={17} />
          Mute
        </span>
        <span className="mic-toggle-off">
          <MicOff size={17} />
          Unmute
        </span>
      </TrackToggle>
    </div>
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
  const [analysis, setAnalysis] = useState<CopilotAnalysis>(defaultAnalysis);
  const [copilotError, setCopilotError] = useState("");
  const [callState, setCallState] = useState<CallState>({
    stage: defaultAnalysis.stage,
    facts: [],
    gaps: ["business impact", "decision process", "timeline", "success criteria"]
  });
  const [connectionState, setConnectionState] = useState("connecting");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [copiedLink, setCopiedLink] = useState<RouteMode | null>(null);
  const [revealedStage, setRevealedStage] = useState<DiscoveryStage | null>(null);
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
        setCopilotError("");
        if (event.analysis) {
          setAnalysis(event.analysis);
        }
        setCallState(event.state);
      } else if (event.type === "copilot.error") {
        setCopilotError(event.error ?? "OpenAI co-pilot analysis failed.");
      }
    });
    return () => socket.close();
  }, []);

  useEffect(() => {
    if (!token) return;
    setElapsedSeconds(0);
    const interval = window.setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(interval);
  }, [token]);

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
      setCopilotError(error instanceof Error ? error.message : "Could not join the LiveKit room.");
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
  const currentStageIndex = Math.max(
    0,
    discoveryArc.findIndex((entry) => entry.stage === analysis.stage)
  );
  const activeRevealedStage = revealedStage ?? analysis.stage;

  async function copyLink(link: string, which: RouteMode) {
    await navigator.clipboard.writeText(link);
    setCopiedLink(which);
    window.setTimeout(() => setCopiedLink((current) => (current === which ? null : current)), 1600);
  }

  return (
    <main className={`shell ${routeMode}`}>
      <div className="backdrop" aria-hidden="true">
        <div className="grain" />
      </div>

      <section className="call-panel">
        <header className="topbar reveal">
          <div className="brand">
            <span className="brand-mark">✦</span>
            <div>
              <h1>{isFounder ? "Discovery Studio" : "Discovery Call"}</h1>
              <p>
                {isFounder
                  ? "Live call, live transcript, restrained next-question suggestions."
                  : "Join the same discovery room without the internal co-pilot workspace."}
              </p>
            </div>
          </div>
          <div className="status-row">
            <span className={`status-pill ${connectionState}`}>
              <span className="pip" />
              {connectionState}
            </span>
            {token ? (
              <span className="status-pill onair">
                <span className="pip live" />
                on air · {formatElapsed(elapsedSeconds)}
              </span>
            ) : null}
            {isFounder ? (
              <span className="status-pill">
                <Sparkles size={13} />
                co-pilot
              </span>
            ) : null}
            <span className="status-pill">
              <Users size={13} />
              shared room
            </span>
          </div>
        </header>

        <section className="video-stage glass reveal d1">
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
              <MicMuteButton />
              <ControlBar controls={{ microphone: false }} />
            </LiveKitRoom>
          ) : (
            <div className="empty-video">
              <span className="empty-glyph">✦</span>
              <h2>The stage is dark</h2>
              <p>Join the room to bring the studio to life.</p>
            </div>
          )}
        </section>

        <section className="join-strip glass reveal d2">
          <label>
            Room
            <input value={roomName} onChange={(event) => setRoomName(event.target.value)} />
          </label>
          <label>
            Identity
            <input value={identity} onChange={(event) => setIdentity(event.target.value)} />
          </label>
          <button className="primary-button" onClick={joinRoom} disabled={isJoining}>
            <Phone size={16} />
            {token ? "Rejoin" : "Go on air"}
          </button>
        </section>

        <section className="invite-strip reveal d3">
          <div className="glass">
            <span>Founder</span>
            <code>{founderLink}</code>
            <button
              className="icon-button"
              onClick={() => copyLink(founderLink, "founder")}
              aria-label="Copy founder link"
            >
              {copiedLink === "founder" ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <div className="glass">
            <span>Prospect</span>
            <code>{prospectLink}</code>
            <button
              className="icon-button"
              onClick={() => copyLink(prospectLink, "prospect")}
              aria-label="Copy prospect link"
            >
              {copiedLink === "prospect" ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </section>

        {isFounder ? (
          <section className="transcript-panel glass reveal d4">
            <div className="section-title">
              <Mic size={16} />
              <h2>Transcript</h2>
              <span className="section-aside">live speech-to-text</span>
            </div>
            <div className="transcript-list">
              {transcript.length === 0 ? (
                <p className="muted empty-transcript">
                  Live speech-to-text appears here during the room. You can still send a manual turn or run the
                  demo.
                </p>
              ) : (
                transcript.map((turn) => (
                  <article key={turn.id} className={`turn ${turn.speaker}${turn.final ? "" : " interim"}`}>
                    <header>
                      <span className="turn-speaker">{turn.speaker === "rep" ? "Founder" : "Prospect"}</span>
                      <span className="turn-time">{formatClock(turn.timestamp)}</span>
                    </header>
                    <p>{turn.text}</p>
                  </article>
                ))
              )}
            </div>
            <div className="composer">
              <div className="segmented" role="tablist" aria-label="Speaker">
                <button className={speaker === "prospect" ? "active" : ""} onClick={() => setSpeaker("prospect")}>
                  <UserRound size={15} />
                  Prospect
                </button>
                <button className={speaker === "rep" ? "active" : ""} onClick={() => setSpeaker("rep")}>
                  <BadgeCheck size={15} />
                  Founder
                </button>
              </div>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") sendTurn();
                }}
                placeholder="Type a transcript turn…"
              />
              <button className="icon-button" onClick={() => sendTurn()} aria-label="Send transcript turn">
                <Send size={17} />
              </button>
              <button className="ghost-button" onClick={runDemo}>
                <Play size={15} />
                Demo
              </button>
            </div>
          </section>
        ) : null}
      </section>

      {isFounder ? (
        <aside className="copilot-panel glass reveal d2">
          <header className="copilot-head">
            <span className="copilot-glyph">❖</span>
            <div>
              <h2>Co-pilot</h2>
              <p>listening to the room</p>
            </div>
          </header>

          <section className="stage-rail">
            <span className="rail-title">Discovery arc</span>
            <ol>
              {discoveryArc.map((entry, index) => {
                const progressState =
                  index < currentStageIndex ? "done" : index === currentStageIndex ? "current" : "ahead";
                const isCurrent = entry.stage === analysis.stage;
                const isRevealed = entry.stage === activeRevealedStage;
                return (
                  <li
                    key={entry.stage}
                    className={`${progressState}${isRevealed ? " revealed" : ""}`}
                    title={`${entry.stage}\nGoal: ${entry.goal}`}
                  >
                    <button
                      type="button"
                      className="rail-trigger"
                      onClick={() => setRevealedStage(entry.stage)}
                      aria-expanded={isRevealed}
                      aria-current={isCurrent ? "step" : undefined}
                    >
                      <span className="rail-step">{String(index + 1).padStart(2, "0")}</span>
                      <span className="rail-copy">
                        <span className="rail-line">
                          <span className="rail-label">{entry.label}</span>
                          {isCurrent ? <span className="rail-current-chip">Current</span> : null}
                        </span>
                        {isRevealed ? (
                          <span className="rail-current-detail">
                            <span>{entry.goal}</span>
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </section>

          {copilotError ? (
            <section className="copilot-card error">
              <span className="card-kicker">
                <CircleAlert size={14} />
                co-pilot error
              </span>
              <h3>Analysis failed</h3>
              <p>{copilotError}</p>
            </section>
          ) : analysis.nextQuestions.length ? (
            <section className="copilot-card">
              <span className="card-kicker">
                <Sparkles size={14} />
                ask next
              </span>
              <div className="question-list">
                {analysis.nextQuestions.map((nextQuestion, index) => (
                  <article
                    key={`${nextQuestion.question}-${index}`}
                    className={`question-card ${nextQuestion.priority}`}
                    style={{ animationDelay: `${index * 90}ms` }}
                  >
                    <span className="priority-chip">{nextQuestion.priority}</span>
                    <h3>{nextQuestion.question}</h3>
                    <p>{nextQuestion.reason}</p>
                  </article>
                ))}
              </div>
              <button className="primary-button">
                <Check size={15} />
                Use top question
              </button>
            </section>
          ) : (
            <section className="copilot-card quiet">
              <span className="card-kicker">
                <span className="pip live" />
                listening
              </span>
              <h3>No recommendation yet</h3>
              <p>The co-pilot is waiting for enough transcript context to recommend the next move.</p>
            </section>
          )}

          <section className="state-panel">
            <h3>Open gaps</h3>
            {callState.gaps.length ? (
              <div className="chip-row">
                {callState.gaps.map((gap, index) => (
                  <span key={`${gap}-${index}`} className="gap-chip">
                    {gap}
                  </span>
                ))}
              </div>
            ) : (
              <p className="muted">All covered ✦</p>
            )}
          </section>

          <section className="facts-panel">
            <h3>Captured facts</h3>
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
