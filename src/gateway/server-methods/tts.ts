import type { GatewayRequestHandlers } from "./types.js";
import path from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig } from "../../config/config.js";
import {
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  getTtsProvider,
  isTtsEnabled,
  isTtsProviderConfigured,
  resolveTtsAutoMode,
  resolveTtsApiKey,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsProviderOrder,
  setTtsEnabled,
  setTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";

function inferMimeTypeFromAudioPath(audioPath: string, outputFormat?: string): string {
  const normalizedFormat = (outputFormat ?? "").toLowerCase();
  if (normalizedFormat.includes("opus")) {
    return "audio/ogg";
  }
  if (normalizedFormat.includes("pcm") || normalizedFormat.includes("wav")) {
    return "audio/wav";
  }
  if (normalizedFormat.includes("webm")) {
    return "audio/webm";
  }
  const ext = path.extname(audioPath).toLowerCase();
  if (ext === ".mp3") {
    return "audio/mpeg";
  }
  if (ext === ".opus" || ext === ".ogg") {
    return "audio/ogg";
  }
  if (ext === ".wav") {
    return "audio/wav";
  }
  if (ext === ".webm") {
    return "audio/webm";
  }
  return "application/octet-stream";
}

export const ttsHandlers: GatewayRequestHandlers = {
  "tts.status": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      const provider = getTtsProvider(config, prefsPath);
      const autoMode = resolveTtsAutoMode({ config, prefsPath });
      const fallbackProviders = resolveTtsProviderOrder(provider)
        .slice(1)
        .filter((candidate) => isTtsProviderConfigured(config, candidate));
      respond(true, {
        enabled: isTtsEnabled(config, prefsPath),
        auto: autoMode,
        provider,
        elevenlabsVoiceId: config.elevenlabs.voiceId,
        elevenlabsModelId: config.elevenlabs.modelId,
        fallbackProvider: fallbackProviders[0] ?? null,
        fallbackProviders,
        prefsPath,
        hasOpenAIKey: Boolean(resolveTtsApiKey(config, "openai")),
        hasElevenLabsKey: Boolean(resolveTtsApiKey(config, "elevenlabs")),
        edgeEnabled: isTtsProviderConfigured(config, "edge"),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.enable": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, true);
      respond(true, { enabled: true });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.disable": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, false);
      respond(true, { enabled: false });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.convert": async ({ params, respond }) => {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "tts.convert requires text"),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const channel = typeof params.channel === "string" ? params.channel.trim() : undefined;
      const result = await textToSpeech({ text, cfg, channel });
      if (result.success && result.audioPath) {
        const audioBuffer = readFileSync(result.audioPath);
        const mimeType = inferMimeTypeFromAudioPath(result.audioPath, result.outputFormat);
        respond(true, {
          audioPath: result.audioPath,
          audioBase64: audioBuffer.toString("base64"),
          mimeType,
          provider: result.provider,
          outputFormat: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
        });
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "TTS conversion failed"),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.setProvider": async ({ params, respond }) => {
    const provider = typeof params.provider === "string" ? params.provider.trim() : "";
    if (provider !== "openai" && provider !== "elevenlabs" && provider !== "edge") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Invalid provider. Use openai, elevenlabs, or edge.",
        ),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsProvider(prefsPath, provider);
      respond(true, { provider });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.providers": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      respond(true, {
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            configured: Boolean(resolveTtsApiKey(config, "openai")),
            models: [...OPENAI_TTS_MODELS],
            voices: [...OPENAI_TTS_VOICES],
          },
          {
            id: "elevenlabs",
            name: "ElevenLabs",
            configured: Boolean(resolveTtsApiKey(config, "elevenlabs")),
            models: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_monolingual_v1"],
          },
          {
            id: "edge",
            name: "Edge TTS",
            configured: isTtsProviderConfigured(config, "edge"),
            models: [],
          },
        ],
        active: getTtsProvider(config, prefsPath),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
