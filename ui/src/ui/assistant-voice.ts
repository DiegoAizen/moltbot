import type { GatewayBrowserClient } from "./gateway.ts";

type TtsConvertResponse = {
  audioBase64?: string;
  mimeType?: string;
};

export type PreparedAssistantVoice = {
  play: () => Promise<boolean>;
  mimeType: string;
};

let currentAudio: HTMLAudioElement | null = null;
let currentAudioUrl: string | null = null;
let playbackPulseTimer: number | null = null;

const playbackListeners = new Set<(level: number, playing: boolean) => void>();

function stopCurrentAudio() {
  teardownAudioMeter();
  if (!currentAudio) {
    return;
  }
  try {
    currentAudio.pause();
  } catch {
    // ignore
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  currentAudio = null;
}

function emitPlayback(level: number, playing: boolean) {
  for (const listener of playbackListeners) {
    try {
      listener(level, playing);
    } catch {
      // ignore listener errors to avoid blocking playback.
    }
  }
}

function teardownAudioMeter() {
  if (playbackPulseTimer != null) {
    window.clearInterval(playbackPulseTimer);
    playbackPulseTimer = null;
  }
  emitPlayback(0, false);
}

function startAudioMeter(audio: HTMLAudioElement) {
  teardownAudioMeter();
  emitPlayback(0.15, true);
  playbackPulseTimer = window.setInterval(() => {
    if (!currentAudio || currentAudio !== audio || audio.paused || audio.ended) {
      return;
    }
    // Lightweight synthetic pulse to keep the UI alive without WebAudio overhead.
    const t = Date.now();
    const waveA = Math.abs(Math.sin(t / 210));
    const waveB = Math.abs(Math.sin(t / 330));
    const level = 0.18 + waveA * 0.5 + waveB * 0.25;
    emitPlayback(Math.min(0.95, level), true);
  }, 90);
}

async function playAssistantVoiceBlob(blob: Blob): Promise<boolean> {
  const objectUrl = URL.createObjectURL(blob);
  stopCurrentAudio();
  const audio = new Audio(objectUrl);
  currentAudioUrl = objectUrl;
  currentAudio = audio;
  startAudioMeter(audio);
  audio.onended = () => {
    if (currentAudio === audio) {
      stopCurrentAudio();
    }
  };
  audio.onerror = () => {
    if (currentAudio === audio) {
      stopCurrentAudio();
    }
  };
  try {
    await audio.play();
    return true;
  } catch (err) {
    console.warn("[ui][tts] Playback failed:", err);
    stopCurrentAudio();
    return false;
  }
}

export function subscribeAssistantVoicePlayback(
  listener: (level: number, playing: boolean) => void,
): () => void {
  playbackListeners.add(listener);
  return () => {
    playbackListeners.delete(listener);
  };
}

export async function prepareAssistantVoiceFromText(
  client: GatewayBrowserClient | null,
  text: string,
): Promise<PreparedAssistantVoice | null> {
  if (!client) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const tts = await client.request<TtsConvertResponse>("tts.convert", {
      text: trimmed,
      channel: "webchat",
    });
    const base64 = tts?.audioBase64?.trim();
    if (!base64) {
      console.warn("[ui][tts] Empty audio payload from tts.convert");
      return null;
    }
    const mimeType = tts?.mimeType?.trim() || "audio/mpeg";
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    return {
      play: async () => playAssistantVoiceBlob(new Blob([bytes], { type: mimeType })),
      mimeType,
    };
  } catch (err) {
    console.warn("[ui][tts] Prepare failed:", err);
    return null;
  }
}

export async function playAssistantVoiceFromText(
  client: GatewayBrowserClient | null,
  text: string,
): Promise<boolean> {
  if (!client) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  const prepared = await prepareAssistantVoiceFromText(client, trimmed);
  if (!prepared) {
    return false;
  }
  return prepared.play();
}
