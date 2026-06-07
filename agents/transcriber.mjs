import "dotenv/config";
import { AutoSubscribe, ServerOptions, cli, defineAgent, inference, voice } from "@livekit/agents";
import * as silero from "@livekit/agents-plugin-silero";
import { fileURLToPath } from "node:url";

const sttModel = process.env.LIVEKIT_STT_MODEL ?? "deepgram/nova-3";
const sttLanguage = process.env.LIVEKIT_STT_LANGUAGE ?? "en";
const agentName = process.env.LIVEKIT_TRANSCRIBER_AGENT_NAME ?? "transcriber";

function getTargetParticipantIdentity(metadata) {
  if (!metadata) return undefined;
  try {
    return JSON.parse(metadata).participantIdentity;
  } catch {
    return undefined;
  }
}

export default defineAgent({
  prewarm: async (proc) => {
    proc.userData.vad = await silero.VAD.load();
  },
  entry: async (ctx) => {
    await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY);
    const targetIdentity = getTargetParticipantIdentity(ctx.info.job.metadata);
    const participant = await ctx.waitForParticipant(targetIdentity);

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
        vad: ctx.proc.userData.vad
      }),
      vad: ctx.proc.userData.vad,
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
