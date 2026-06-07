import { useEffect, useMemo, useRef, useState } from "react";
import {
  ControlBar,
  GridLayout,
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  TrackToggle,
  useRoomContext,
  useTracks
} from "@livekit/components-react";
import { RoomEvent, Track, type Participant, type TrackPublication, type TranscriptionSegment } from "livekit-client";
import {
  BadgeCheck,
  Check,
  CircleAlert,
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

const defaultOpenGaps = [
  "concrete instance",
  "cost & frequency",
  "existing workaround / spend",
  "decision power",
  "commitment"
];

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

const stagePromptPlaceholders: Record<DiscoveryStage, NextQuestion[]> = {
  "Frame & Disarm": [
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
  ],
  "Find a problem & get into a story": [
    {
      priority: "medium",
      question: "Can you walk me through the last time this came up?",
      reason: "Pushes toward a concrete recent story."
    },
    {
      priority: "medium",
      question: "Where were you, who was involved, and what happened next?",
      reason: "Keeps the answer out of generalities."
    }
  ],
  "Quantify the pain": [
    {
      priority: "medium",
      question: "Roughly how much time or money did that specific instance cost?",
      reason: "Turns the story into measurable pain."
    },
    {
      priority: "medium",
      question: "How often does something like that happen?",
      reason: "Separates a one-off annoyance from a recurring problem."
    }
  ],
  "Find the behavioural residue": [
    {
      priority: "medium",
      question: "What have you already tried to fix or work around this?",
      reason: "Looks for real time, budget, or effort already spent."
    },
    {
      priority: "medium",
      question: "Have you built, bought, hacked together, or assigned anyone to solve it?",
      reason: "Surfaces existing behavior instead of stated interest."
    }
  ],
  "Gauge intent / Active search": [
    {
      priority: "medium",
      question: "Is this something you are actively trying to solve right now?",
      reason: "Distinguishes active search from someday interest."
    },
    {
      priority: "medium",
      question: "If a good answer existed, what would have to happen for you to move on it?",
      reason: "Tests whether budget and urgency exist."
    }
  ],
  "Test commitment": [
    {
      priority: "medium",
      question: "Would it be worth putting 30 minutes on the calendar to look at this with your real workflow?",
      reason: "Asks for a costly next action."
    },
    {
      priority: "medium",
      question: "Who else would need to be in the room if this were worth pursuing?",
      reason: "Looks for advancement instead of polite interest."
    }
  ],
  "Close on the next step": [
    {
      priority: "medium",
      question: "What is the concrete next step from here, if there is one?",
      reason: "Forces clarity instead of vague follow-up."
    },
    {
      priority: "medium",
      question: "Should we put a date on that now, or call it not a priority?",
      reason: "Makes absence of commitment explicit."
    }
  ]
};

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
  stage: "Frame & Disarm",
  nextQuestions: stagePromptPlaceholders["Frame & Disarm"]
};

function getRouteMode(): RouteMode {
  if (window.location.pathname.startsWith("/prospect")) return "prospect";
  return "founder";
}

function getWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const isViteDevServer =
    (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") &&
    window.location.port !== "" &&
    window.location.port !== "8787";
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
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare], { onlySubscribed: false });

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
  const room = useRoomContext();

  useEffect(() => {
    function handleTranscription(
      segments: TranscriptionSegment[],
      participant?: Participant,
      _publication?: TrackPublication
    ) {
      if (!participant) return;

      segments.forEach((segment) => {
        const text = segment.text.trim();
        if (!text) return;

        onTranscript({
          id: `${participant.identity}:${segment.id}`,
          speaker: speakerFromIdentity(participant.identity),
          text,
          timestamp: new Date(segment.firstReceivedTime || Date.now()).toISOString(),
          final: segment.final
        });
      });
    }

    room.on(RoomEvent.TranscriptionReceived, handleTranscription);
    return () => {
      room.off(RoomEvent.TranscriptionReceived, handleTranscription);
    };
  }, [onTranscript, room]);

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
    gaps: defaultOpenGaps
  });
  const [connectionState, setConnectionState] = useState("connecting");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [revealedStage, setRevealedStage] = useState<DiscoveryStage | null>(null);
  const callId = roomName;
  const wsRef = useRef<WebSocket | null>(null);
  const callIdRef = useRef(callId);
  const sentLiveTranscriptIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    callIdRef.current = callId;
  }, [callId]);

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
      if (event.callId && event.callId !== callIdRef.current) return;
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
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "call.subscribe", callId }));
  }, [callId, connectionState]);

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
  const currentStageIndex = Math.max(
    0,
    discoveryArc.findIndex((entry) => entry.stage === analysis.stage)
  );
  const activeRevealedStage = revealedStage ?? analysis.stage;
  const visiblePrompts = (transcript.length ? analysis.nextQuestions : stagePromptPlaceholders[activeRevealedStage]).slice(0, 2);

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
              <h1>{isFounder ? "Sales Co-Pilot" : "Discovery Call"}</h1>
              {isFounder ? null : <p>Join the same discovery room without the internal co-pilot workspace.</p>}
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

        {isFounder ? (
          <section className="transcript-panel glass reveal d3">
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
                const isExpanded = isCurrent || isRevealed;
                return (
                  <li
                    key={entry.stage}
                    className={`${progressState}${isExpanded ? " revealed" : ""}`}
                    title={`${entry.stage}\nGoal: ${entry.goal}`}
                  >
                    <button
                      type="button"
                      className="rail-trigger"
                      onClick={() => setRevealedStage(entry.stage)}
                      aria-expanded={isExpanded}
                      aria-current={isCurrent ? "step" : undefined}
                    >
                      <span className="rail-step">{String(index + 1).padStart(2, "0")}</span>
                      <span className="rail-copy">
                        <span className="rail-line">
                          <span className="rail-label">{entry.label}</span>
                          {isCurrent ? <span className="rail-current-chip">Current</span> : null}
                        </span>
                        {isExpanded ? (
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
          ) : visiblePrompts.length ? (
            <section className="copilot-card">
              <span className="card-kicker">
                <Sparkles size={14} />
                try next
              </span>
              <div className="question-list">
                {visiblePrompts.map((nextQuestion, index) => (
                  <article
                    key={`${nextQuestion.question}-${index}`}
                    className={`question-card ${nextQuestion.priority}`}
                    style={{ animationDelay: `${index * 90}ms` }}
                  >
                    <span className="priority-chip">{nextQuestion.priority}</span>
                    <h3>{nextQuestion.question}</h3>
                  </article>
                ))}
              </div>
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
