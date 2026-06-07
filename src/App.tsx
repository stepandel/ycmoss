import { useEffect, useMemo, useRef, useState } from "react";
import {
  DisconnectButton,
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
  Check,
  CircleAlert,
  Mic,
  MicOff,
  MonitorUp,
  ShieldCheck,
  Sparkles,
  Video,
  VideoOff
} from "lucide-react";
import { identityFromZoomContext, roomNameFromZoomContext, useZoomAppContext } from "./zoom";

type Speaker = "rep" | "prospect";

type TranscriptTurn = {
  id: string;
  speaker: Speaker;
  text: string;
  timestamp: string;
  final: boolean;
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

type FluffGuardState = "collecting_facts" | "mixed" | "collecting_fluff" | "insufficient_context";

type FluffGuardAnalysis = {
  state: FluffGuardState;
  confidence: number;
  label: string;
  signal: string;
  evidence: string[];
  suggestedProbe: string;
};

type PitchDriftAnalysis = {
  state: PitchDriftState;
  confidence: number;
  shouldWarn: boolean;
  warning: string;
  recoveryQuestion: string;
  reasons: string[];
  fluffGuard: FluffGuardAnalysis;
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
type LiveKitConnectionState = "idle" | "connecting" | "connected" | "disconnected" | "error";

// TODO: pull from room metadata / CRM once available
const prospect = {
  name: "Aashil",
  title: "Principal Engineer",
  company: "Oracle"
};

const defaultOpenGaps = [
  "concrete instance",
  "cost & frequency",
  "existing workaround / spend",
  "decision power",
  "commitment"
];

const discoveryArc: Array<{ stage: DiscoveryStage; label: string; goal: string }> = [
  {
    stage: "Just here to learn",
    label: "Just here to learn",
    goal: "Get your idea off the table."
  },
  {
    stage: "When did it last happen",
    label: "When did it last happen",
    goal: "Pin them to a specific, recent instance."
  },
  {
    stage: "Quantify the pain",
    label: "Quantify the pain",
    goal: "Establish cost, frequency, and downstream consequence of that instance."
  },
  {
    stage: "What have they tried?",
    label: "What have they tried?",
    goal: "Uncover what they have already tried, built, or paid for."
  },
  {
    stage: "Are they already solving it?",
    label: "Are they already solving it?",
    goal: "Determine if they are solving this now or it is a someday item."
  },
  {
    stage: "Ask for commitment",
    label: "Ask for commitment",
    goal: "Float your direction lightly and ask for something costly: time, an intro, or money."
  },
  {
    stage: "Lock next steps",
    label: "Lock next steps",
    goal: "Lock a concrete dated advancement, or explicitly name that there is not one."
  }
];

const stagePromptPlaceholders: Record<DiscoveryStage, NextQuestion[]> = {
  "Just here to learn": [
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
  "When did it last happen": [
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
  "What have they tried?": [
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
  "Are they already solving it?": [
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
  "Ask for commitment": [
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
  "Lock next steps": [
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

const defaultAnalysis: CopilotAnalysis = {
  stage: "Just here to learn",
  nextQuestions: stagePromptPlaceholders["Just here to learn"]
};

const defaultPitchDrift: PitchDriftAnalysis = {
  state: "on_discovery_path",
  confidence: 0,
  shouldWarn: false,
  warning: "",
  recoveryQuestion: "Can you walk me through the last time this happened?",
  reasons: [],
  fluffGuard: {
    state: "insufficient_context",
    confidence: 0,
    label: "Waiting for evidence",
    signal: "No real signal yet.",
    evidence: [],
    suggestedProbe: "Can you walk me through the last time this happened?"
  }
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

function ControlDock() {
  return (
    <footer className="control-dock">
      <div className="dock-cluster">
        <TrackToggle
          className="dock-button"
          source={Track.Source.Microphone}
          showIcon={false}
          aria-label="Toggle microphone"
          title="Toggle microphone"
        >
          <span className="dock-on">
            <Mic size={22} />
            <small>Mute</small>
          </span>
          <span className="dock-off">
            <MicOff size={22} />
            <small>Unmute</small>
          </span>
        </TrackToggle>
        <TrackToggle
          className="dock-button"
          source={Track.Source.Camera}
          showIcon={false}
          aria-label="Toggle camera"
          title="Toggle camera"
        >
          <span className="dock-on">
            <Video size={22} />
            <small>Stop video</small>
          </span>
          <span className="dock-off">
            <VideoOff size={22} />
            <small>Start video</small>
          </span>
        </TrackToggle>
      </div>
      <div className="dock-cluster">
        <TrackToggle
          className="dock-button share"
          source={Track.Source.ScreenShare}
          showIcon={false}
          aria-label="Toggle screen share"
          title="Toggle screen share"
        >
          <span className="dock-on">
            <MonitorUp size={22} />
            <small>Stop share</small>
          </span>
          <span className="dock-off">
            <MonitorUp size={22} />
            <small>Share</small>
          </span>
        </TrackToggle>
      </div>
      <div className="dock-cluster end">
        <DisconnectButton className="leave-button">Leave</DisconnectButton>
      </div>
    </footer>
  );
}

type PreJoinDockProps = {
  onJoin: () => void;
  isJoining: boolean;
};

function PreJoinDock({ onJoin, isJoining }: PreJoinDockProps) {
  return (
    <footer className="control-dock">
      <div className="dock-cluster">
        <button className="dock-button" type="button" disabled>
          <span className="dock-on">
            <Mic size={22} />
            <small>Mute</small>
          </span>
        </button>
        <button className="dock-button" type="button" disabled>
          <span className="dock-on">
            <Video size={22} />
            <small>Start video</small>
          </span>
        </button>
      </div>
      <div className="dock-cluster">
        <button className="dock-button" type="button" disabled>
          <span className="dock-on">
            <MonitorUp size={22} />
            <small>Share</small>
          </span>
        </button>
      </div>
      <div className="dock-cluster end">
        <button className="join-button" type="button" onClick={onJoin} disabled={isJoining}>
          {isJoining ? "Joining…" : "Join"}
        </button>
      </div>
    </footer>
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
  const zoomContext = useZoomAppContext();
  const fallbackIdentityRef = useRef(`${routeMode}-${Math.floor(Math.random() * 9000) + 1000}`);
  const roomName = initialParams.get("room") ?? roomNameFromZoomContext(zoomContext) ?? "discovery-demo";
  const identity = useMemo(
    () => initialParams.get("identity") ?? identityFromZoomContext(zoomContext) ?? fallbackIdentityRef.current,
    [initialParams, zoomContext]
  );
  const [config, setConfig] = useState<Config | null>(null);
  const [token, setToken] = useState("");
  const [isJoining, setIsJoining] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [analysis, setAnalysis] = useState<CopilotAnalysis>(defaultAnalysis);
  const [pitchDrift, setPitchDrift] = useState<PitchDriftAnalysis>(defaultPitchDrift);
  const [copilotError, setCopilotError] = useState("");
  const [callState, setCallState] = useState<CallState>({
    stage: defaultAnalysis.stage,
    facts: [],
    gaps: defaultOpenGaps
  });
  const [connectionState, setConnectionState] = useState("connecting");
  const [liveKitConnectionState, setLiveKitConnectionState] = useState<LiveKitConnectionState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [revealedStage, setRevealedStage] = useState<DiscoveryStage | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"copilot" | "transcript">("copilot");
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
        if (event.pitchDrift) {
          setPitchDrift(event.pitchDrift);
        }
        setCallState(event.state);
      } else if (event.type === "copilot.error") {
        setCopilotError(event.error ?? "MiniMax co-pilot analysis failed.");
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
    if (!token) {
      setLiveKitConnectionState("idle");
    }
  }, [token]);

  useEffect(() => {
    if (liveKitConnectionState !== "connected") return;
    const interval = window.setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(interval);
  }, [liveKitConnectionState]);

  async function joinRoom() {
    setIsJoining(true);
    setCopilotError("");
    setLiveKitConnectionState("connecting");
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
      setLiveKitConnectionState("error");
      setCopilotError(error instanceof Error ? error.message : "Could not join the LiveKit room.");
    } finally {
      setIsJoining(false);
    }
  }

  async function startZoomRtms() {
    try {
      await zoomContext.startRtms();
      setCopilotError("");
    } catch (error) {
      setCopilotError(error instanceof Error ? error.message : "Could not start Zoom RTMS.");
    }
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

  const isFounder = routeMode === "founder";
  const isLiveKitReady = Boolean(config?.livekitUrl && token);
  const isLiveKitConnected = liveKitConnectionState === "connected";
  const currentStageIndex = Math.max(
    0,
    discoveryArc.findIndex((entry) => entry.stage === analysis.stage)
  );
  const activeRevealedStage = revealedStage ?? analysis.stage;
  const visiblePrompts = (transcript.length ? analysis.nextQuestions : stagePromptPlaceholders[activeRevealedStage]).slice(0, 2);
  const fluffGuard = pitchDrift.fluffGuard;
  // Meet-style live captions: surface the latest transcript turn while it is fresh.
  // The elapsed-seconds ticker re-renders every second, which ages captions out.
  const latestTurn = transcript.length ? transcript[transcript.length - 1] : null;
  const captionTurn =
    isLiveKitConnected && latestTurn && Date.now() - new Date(latestTurn.timestamp).getTime() < 8000
      ? latestTurn
      : null;

  return (
    <main className={`shell ${routeMode}`}>
      <section className="call-panel">
        <header className="topbar">
          <div className="meeting-info">
            <span className="meeting-shield" title="End-to-end encrypted">
              <ShieldCheck size={15} />
            </span>
            <h1>{isFounder ? "Sales Co-Pilot" : "Discovery Call"}</h1>
            <span className="meeting-id">{roomName}</span>
          </div>
          <div className="status-row">
            {isLiveKitConnected ? (
              <span className="rec-pill">
                <span className="pip live" />
                {formatElapsed(elapsedSeconds)}
              </span>
            ) : null}
            <span className={`status-pill ${connectionState}`} title={`Co-pilot ${connectionState}`}>
              <span className="pip" />
              co-pilot
            </span>
            <span className={`status-pill ${liveKitConnectionState}`} title={`Room ${liveKitConnectionState}`}>
              <span className="pip" />
              room
            </span>
            <span className={`status-pill zoom-${zoomContext.status}`}>
              <Video size={13} />
              {zoomContext.status === "ready" ? zoomContext.runningContext : `zoom ${zoomContext.status}`}
            </span>
          </div>
        </header>

        {isLiveKitReady && config ? (
          <LiveKitRoom
            serverUrl={config.livekitUrl}
            token={token}
            connect
            video
            audio
            className="meeting-area"
            onConnected={() => {
              setElapsedSeconds(0);
              setLiveKitConnectionState("connected");
              setCopilotError("");
            }}
            onDisconnected={() => {
              setLiveKitConnectionState("disconnected");
              setToken("");
            }}
            onError={(error) => {
              setLiveKitConnectionState("error");
              setCopilotError(error.message || "Could not connect to the LiveKit room.");
            }}
            onMediaDeviceFailure={(_failure, kind) => {
              setCopilotError(`${kind ?? "Media"} permission or device setup failed.`);
            }}
          >
            <div className="video-stage">
              <LiveTranscriptionBridge onTranscript={handleLiveTranscript} />
              <VideoGrid />
              <RoomAudioRenderer />
              {captionTurn ? (
                <div className="captions-overlay" aria-live="polite">
                  <span className="caption-speaker">
                    {captionTurn.speaker === "rep" ? "Founder" : "Prospect"}
                  </span>
                  <p>{captionTurn.text}</p>
                </div>
              ) : null}
            </div>
            <ControlDock />
          </LiveKitRoom>
        ) : (
          <div className="meeting-area">
            <div className="video-stage">
              <div className="empty-video">
                <span className="empty-avatar">{identity.slice(0, 2).toUpperCase()}</span>
                <h2>Ready to join?</h2>
                <p>Your camera and microphone will turn on when you join the call.</p>
                <button className="join-button large" type="button" onClick={joinRoom} disabled={isJoining}>
                  {isJoining ? "Joining…" : token ? "Rejoin now" : "Join now"}
                </button>
              </div>
            </div>
            <PreJoinDock onJoin={joinRoom} isJoining={isJoining} />
          </div>
        )}
      </section>

      {isFounder ? (
        <aside className="side-panel">
          <nav className="panel-tabs" role="tablist" aria-label="Side panel">
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === "copilot"}
              className={sidebarTab === "copilot" ? "active" : ""}
              onClick={() => setSidebarTab("copilot")}
            >
              <Sparkles size={14} />
              Co-Pilot
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebarTab === "transcript"}
              className={sidebarTab === "transcript" ? "active" : ""}
              onClick={() => setSidebarTab("transcript")}
            >
              <Mic size={14} />
              Transcript
              {transcript.length ? <span className="tab-count">{transcript.length}</span> : null}
            </button>
          </nav>

          {sidebarTab === "transcript" ? (
            <div className="panel-body transcript-body">
              <div className="transcript-list">
                {transcript.length === 0 ? (
                  <p className="muted empty-transcript">Live speech-to-text appears here during the call.</p>
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
            </div>
          ) : (
            <div className="panel-body">
          <header className="copilot-head">
            <span className="copilot-glyph">❖</span>
            <div>
              <h2>{zoomContext.meeting?.meetingTopic ?? prospect.name}</h2>
              <p>
                {zoomContext.user?.screenName
                  ? `${zoomContext.user.screenName} · ${zoomContext.user.role ?? "Zoom participant"}`
                  : `${prospect.title} · ${prospect.company}`}
              </p>
            </div>
          </header>

          {zoomContext.status === "ready" ? (
            <section className="zoom-panel">
              <span className="card-kicker">
                <Video size={14} />
                zoom app
              </span>
              <div className="zoom-meta">
                <span>Context</span>
                <strong>{zoomContext.runningContext}</strong>
                <span>Room</span>
                <strong>{roomName}</strong>
                <span>RTMS</span>
                <strong>{zoomContext.rtmsStatus ?? "not started"}</strong>
              </div>
              <button
                className="ghost-button zoom-action"
                type="button"
                onClick={startZoomRtms}
                disabled={!zoomContext.isInMeeting}
              >
                <Video size={15} />
                Start RTMS
              </button>
            </section>
          ) : null}

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
          ) : null}

          {!copilotError && pitchDrift.shouldWarn ? (
            <section className={`copilot-card pitch-drift ${pitchDrift.state}`}>
              <span className="card-kicker">
                <CircleAlert size={14} />
                discovery guardrail
              </span>
              <h3>{pitchDrift.warning || "You may be drifting into pitch mode."}</h3>
              <article className="recovery-card">
                <span>Try this</span>
                <p>{pitchDrift.recoveryQuestion}</p>
              </article>
              {pitchDrift.reasons.length ? <p>{pitchDrift.reasons[0]}</p> : null}
            </section>
          ) : null}

          {!copilotError ? (
            <section className={`fluff-guard ${fluffGuard.state}`}>
              <div className="fluff-guard-head">
                <span className="card-kicker">fluff guard</span>
                <span className="fluff-guard-meter">
                  <span />
                  {Math.round(fluffGuard.confidence * 100)}%
                </span>
              </div>
              <h3>{fluffGuard.label}</h3>
              <p>{fluffGuard.signal}</p>
              {fluffGuard.evidence.length ? (
                <ul>
                  {fluffGuard.evidence.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
              ) : null}
              <article className="recovery-card compact">
                <span>Convert to fact</span>
                <p>{fluffGuard.suggestedProbe}</p>
              </article>
            </section>
          ) : null}

          {!copilotError && visiblePrompts.length ? (
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
          ) : !copilotError ? (
            <section className="copilot-card quiet">
              <span className="card-kicker">
                <span className="pip live" />
                listening
              </span>
              <h3>No recommendation yet</h3>
              <p>The co-pilot is waiting for enough transcript context to recommend the next move.</p>
            </section>
          ) : null}

          <section className="state-panel">
            <h3>Discovery gaps</h3>
            <div className="chip-row">
              {defaultOpenGaps.map((gap) => {
                const isComplete = !callState.gaps.includes(gap);

                return (
                  <span key={gap} className={`gap-chip ${isComplete ? "complete" : "open"}`}>
                    {isComplete ? <Check size={13} strokeWidth={2.4} aria-hidden="true" /> : null}
                    {gap}
                  </span>
                );
              })}
            </div>
          </section>

              {callState.facts.length ? (
                <section className="facts-panel">
                  <h3>Captured facts</h3>
                  <ul>
                    {callState.facts.map((fact, index) => (
                      <li key={`${fact}-${index}`}>{fact}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          )}
        </aside>
      ) : null}
    </main>
  );
}
