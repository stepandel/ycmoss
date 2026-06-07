import "dotenv/config";
import { AutoSubscribe, ServerOptions, cli, defineAgent, inference, voice, type JobProcess } from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { fileURLToPath } from "node:url";

type TranscriberProcessData = {
  vad?: silero.VAD;
};

type DispatchMetadata = {
  participantIdentity?: string;
};

const sttModel = process.env.LIVEKIT_STT_MODEL ?? "deepgram/nova-3";
const sttLanguage = process.env.LIVEKIT_STT_LANGUAGE ?? "en";
const agentName = process.env.LIVEKIT_TRANSCRIBER_AGENT_NAME ?? "transcriber";

function getTargetParticipantIdentity(metadata: string): string | undefined {
  if (!metadata) return undefined;
  try {
    const parsed = JSON.parse(metadata) as DispatchMetadata;
    return typeof parsed.participantIdentity === "string" ? parsed.participantIdentity : undefined;
  } catch {
    return undefined;
  }
}

export default defineAgent<TranscriberProcessData>({
  prewarm: async (proc: JobProcess<TranscriberProcessData>) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx) => {
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    const targetIdentity = getTargetParticipantIdentity(ctx.info.job.metadata);
    const participant = await ctx.waitForParticipant(targetIdentity);
    const vad = ctx.proc.userData.vad;

    if (!vad) {
      throw new Error("Transcriber VAD was not initialized.");
    }

    const agent = new voice.Agent({
      instructions: "Transcribe the linked participant. Do not speak or generate replies."
    });

    const session = new voice.AgentSession({
      stt: new inference.STT({
        model: sttModel,
        language: sttLanguage,
        modelOptions: {
          interim_results: true,
          punctuate: true,
          smart_format: true
        },
        vad
      }),
      vad,
      userAwayTimeout: null
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        audioEnabled: true,
        textEnabled: false,
        participantIdentity: participant.identity
      },
      outputOptions: {
        audioEnabled: false,
        transcriptionEnabled: true,
        syncTranscription: false
      }
    });

    console.log(`Transcribing ${participant.identity} in room ${ctx.room.name} with ${sttModel}:${sttLanguage}`);
  }
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName }));
