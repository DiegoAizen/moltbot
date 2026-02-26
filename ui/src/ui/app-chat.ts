import type { OpenClawApp } from "./app.ts";
import type { GatewayHelloOk } from "./gateway.ts";
import type { ChatAttachment, ChatQueueItem } from "./ui-types.ts";
import { parseAgentSessionKey } from "../../../src/sessions/session-key-utils.js";
import { scheduleChatScroll } from "./app-scroll.ts";
import { setLastActiveSessionKey } from "./app-settings.ts";
import { resetToolStream } from "./app-tool-stream.ts";
import { abortChatRun, loadChatHistory, sendChatMessage } from "./controllers/chat.ts";
import { loadSessions } from "./controllers/sessions.ts";
import { normalizeBasePath } from "./navigation.ts";
import { generateUUID } from "./uuid.ts";

export type ChatHost = {
  connected: boolean;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
  chatQueue: ChatQueueItem[];
  chatRunId: string | null;
  chatSending: boolean;
  sessionKey: string;
  basePath: string;
  hello: GatewayHelloOk | null;
  chatAvatarUrl: string | null;
  refreshSessionsAfterChat: Set<string>;
  voiceMode: boolean;
  recording: boolean;
};

export const CHAT_SESSIONS_ACTIVE_MINUTES = 120;

export function isChatBusy(host: ChatHost) {
  return host.chatSending || Boolean(host.chatRunId);
}

export function isChatStopCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/stop") {
    return true;
  }
  return (
    normalized === "stop" ||
    normalized === "esc" ||
    normalized === "abort" ||
    normalized === "wait" ||
    normalized === "exit"
  );
}

function isChatResetCommand(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "/new" || normalized === "/reset") {
    return true;
  }
  return normalized.startsWith("/new ") || normalized.startsWith("/reset ");
}

export async function handleAbortChat(host: ChatHost) {
  if (!host.connected) {
    return;
  }
  host.chatMessage = "";
  await abortChatRun(host as unknown as OpenClawApp);
}

function enqueueChatMessage(
  host: ChatHost,
  text: string,
  attachments?: ChatAttachment[],
  refreshSessions?: boolean,
) {
  const trimmed = text.trim();
  const hasAttachments = Boolean(attachments && attachments.length > 0);
  if (!trimmed && !hasAttachments) {
    return;
  }
  host.chatQueue = [
    ...host.chatQueue,
    {
      id: generateUUID(),
      text: trimmed,
      createdAt: Date.now(),
      attachments: hasAttachments ? attachments?.map((att) => ({ ...att })) : undefined,
      refreshSessions,
    },
  ];
}

async function sendChatMessageNow(
  host: ChatHost,
  message: string,
  opts?: {
    previousDraft?: string;
    restoreDraft?: boolean;
    attachments?: ChatAttachment[];
    previousAttachments?: ChatAttachment[];
    restoreAttachments?: boolean;
    refreshSessions?: boolean;
  },
) {
  resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
  const runId = await sendChatMessage(host as unknown as OpenClawApp, message, opts?.attachments);
  const ok = Boolean(runId);
  if (!ok && opts?.previousDraft != null) {
    host.chatMessage = opts.previousDraft;
  }
  if (!ok && opts?.previousAttachments) {
    host.chatAttachments = opts.previousAttachments;
  }
  if (ok) {
    setLastActiveSessionKey(
      host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
      host.sessionKey,
    );
  }
  if (ok && opts?.restoreDraft && opts.previousDraft?.trim()) {
    host.chatMessage = opts.previousDraft;
  }
  if (ok && opts?.restoreAttachments && opts.previousAttachments?.length) {
    host.chatAttachments = opts.previousAttachments;
  }
  scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  if (ok && !host.chatRunId) {
    void flushChatQueue(host);
  }
  if (ok && opts?.refreshSessions && runId) {
    host.refreshSessionsAfterChat.add(runId);
  }
  return ok;
}

async function flushChatQueue(host: ChatHost) {
  if (!host.connected || isChatBusy(host)) {
    return;
  }
  const [next, ...rest] = host.chatQueue;
  if (!next) {
    return;
  }
  host.chatQueue = rest;
  const ok = await sendChatMessageNow(host, next.text, {
    attachments: next.attachments,
    refreshSessions: next.refreshSessions,
  });
  if (!ok) {
    host.chatQueue = [next, ...host.chatQueue];
  }
}

export function removeQueuedMessage(host: ChatHost, id: string) {
  host.chatQueue = host.chatQueue.filter((item) => item.id !== id);
}

export async function handleSendChat(
  host: ChatHost,
  messageOverride?: string,
  opts?: { restoreDraft?: boolean },
) {
  if (!host.connected) {
    return;
  }
  const previousDraft = host.chatMessage;
  const message = (messageOverride ?? host.chatMessage).trim();
  const attachments = host.chatAttachments ?? [];
  const attachmentsToSend = messageOverride == null ? attachments : [];
  const hasAttachments = attachmentsToSend.length > 0;

  // Allow sending with just attachments (no message text required)
  if (!message && !hasAttachments) {
    return;
  }

  if (isChatStopCommand(message)) {
    await handleAbortChat(host);
    return;
  }

  const refreshSessions = isChatResetCommand(message);
  if (messageOverride == null) {
    host.chatMessage = "";
    // Clear attachments when sending
    host.chatAttachments = [];
  }

  if (isChatBusy(host)) {
    enqueueChatMessage(host, message, attachmentsToSend, refreshSessions);
    return;
  }

  await sendChatMessageNow(host, message, {
    previousDraft: messageOverride == null ? previousDraft : undefined,
    restoreDraft: Boolean(messageOverride && opts?.restoreDraft),
    attachments: hasAttachments ? attachmentsToSend : undefined,
    previousAttachments: messageOverride == null ? attachments : undefined,
    restoreAttachments: Boolean(messageOverride && opts?.restoreDraft),
    refreshSessions,
  });
}

export async function refreshChat(host: ChatHost, opts?: { scheduleScroll?: boolean }) {
  await Promise.all([
    loadChatHistory(host as unknown as OpenClawApp),
    loadSessions(host as unknown as OpenClawApp, {
      activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
    }),
    refreshChatAvatar(host),
  ]);
  if (opts?.scheduleScroll !== false) {
    scheduleChatScroll(host as unknown as Parameters<typeof scheduleChatScroll>[0]);
  }
}

export const flushChatQueueForEvent = flushChatQueue;

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
};

function resolveAgentIdForSession(host: ChatHost): string | null {
  const parsed = parseAgentSessionKey(host.sessionKey);
  if (parsed?.agentId) {
    return parsed.agentId;
  }
  const snapshot = host.hello?.snapshot as
    | { sessionDefaults?: SessionDefaultsSnapshot }
    | undefined;
  const fallback = snapshot?.sessionDefaults?.defaultAgentId?.trim();
  return fallback || "main";
}

function buildAvatarMetaUrl(basePath: string, agentId: string): string {
  const base = normalizeBasePath(basePath);
  const encoded = encodeURIComponent(agentId);
  return base ? `${base}/avatar/${encoded}?meta=1` : `/avatar/${encoded}?meta=1`;
}

export async function refreshChatAvatar(host: ChatHost) {
  if (!host.connected) {
    host.chatAvatarUrl = null;
    return;
  }
  const agentId = resolveAgentIdForSession(host);
  if (!agentId) {
    host.chatAvatarUrl = null;
    return;
  }
  host.chatAvatarUrl = null;
  const url = buildAvatarMetaUrl(host.basePath, agentId);
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      host.chatAvatarUrl = null;
      return;
    }
    const data = (await res.json()) as { avatarUrl?: unknown };
    const avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
    host.chatAvatarUrl = avatarUrl || null;
  } catch {
    host.chatAvatarUrl = null;
  }
}

// Voice recording functionality

type BrowserSpeechRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult:
    | ((
        event: {
          resultIndex?: number;
          results: ArrayLike<
            {
              isFinal?: boolean;
              [index: number]: { transcript: string } | undefined;
              length: number;
            }
          >;
        },
      ) => void)
    | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let speechRecognition: BrowserSpeechRecognition | null = null;
let speechTranscript = "";
let speechFinalizedTranscript = "";
let speechFinalizeTimer: number | null = null;
let speechRestartTimer: number | null = null;
let speechInactivityTimer: number | null = null;
let speechStopRequested = false;
let lastFlushedTranscript = "";
let lastFlushedAt = 0;
const SPEECH_INACTIVITY_MS = 10_000;

function clearSpeechTimers() {
  if (speechFinalizeTimer != null) {
    window.clearTimeout(speechFinalizeTimer);
    speechFinalizeTimer = null;
  }
  if (speechRestartTimer != null) {
    window.clearTimeout(speechRestartTimer);
    speechRestartTimer = null;
  }
  if (speechInactivityTimer != null) {
    window.clearTimeout(speechInactivityTimer);
    speechInactivityTimer = null;
  }
}

function scheduleSpeechInactivityStop(host: ChatHost) {
  if (speechInactivityTimer != null) {
    window.clearTimeout(speechInactivityTimer);
  }
  speechInactivityTimer = window.setTimeout(() => {
    speechInactivityTimer = null;
    if (!host.voiceMode || !host.recording) {
      return;
    }
    stopVoiceRecording(host);
  }, SPEECH_INACTIVITY_MS);
}

function flushRecognizedText(host: ChatHost) {
  const finalText = (speechFinalizedTranscript || speechTranscript).trim();
  speechTranscript = "";
  speechFinalizedTranscript = "";
  if (!finalText) {
    return;
  }
  const now = Date.now();
  if (finalText === lastFlushedTranscript && now - lastFlushedAt < 6000) {
    return;
  }
  lastFlushedTranscript = finalText;
  lastFlushedAt = now;
  void handleSendChat(host, finalText);
}

function scheduleSpeechRestart(host: ChatHost, delayMs: number) {
  if (!host.voiceMode || speechStopRequested) {
    return;
  }
  if (speechRestartTimer != null) {
    return;
  }
  host.recording = true;
  speechRestartTimer = window.setTimeout(() => {
    speechRestartTimer = null;
    if (!host.voiceMode || speechStopRequested || speechRecognition) {
      return;
    }
    host.recording = false;
    void startVoiceRecording(host);
  }, Math.max(300, delayMs));
}

export function toggleVoiceMode(host: ChatHost) {
  host.voiceMode = !host.voiceMode;
  if (host.voiceMode) {
    void startVoiceRecording(host);
    return;
  }
  stopVoiceRecording(host);
  host.recording = false;
}

export async function startVoiceRecording(host: ChatHost) {
  if (!host.voiceMode) {
    host.recording = false;
    return;
  }
  if (!host.connected || speechRecognition || (host.recording && speechRestartTimer == null)) {
    return;
  }

  const speechApi = (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor })
    .webkitSpeechRecognition;

  if (speechApi) {
    try {
      clearSpeechTimers();
      speechStopRequested = false;
      speechTranscript = "";
      speechFinalizedTranscript = "";
      speechRecognition = new speechApi();
      speechRecognition.lang = navigator.language || "es-ES";
      speechRecognition.continuous = true;
      speechRecognition.interimResults = true;
      speechRecognition.maxAlternatives = 1;
      speechRecognition.onresult = (event) => {
        let interim = "";
        let gotFinal = false;
        const start = Math.max(0, event.resultIndex ?? 0);
        for (let i = start; i < event.results.length; i++) {
          const result = event.results[i];
          const alt = result?.[0];
          const text = alt?.transcript?.trim();
          if (!text) {
            continue;
          }
          if (result?.isFinal) {
            speechFinalizedTranscript = speechFinalizedTranscript
              ? `${speechFinalizedTranscript} ${text}`
              : text;
            gotFinal = true;
            continue;
          }
          interim = `${interim} ${text}`.trim();
        }
        speechTranscript = (speechFinalizedTranscript || interim).trim();
        if (speechTranscript || speechFinalizedTranscript) {
          scheduleSpeechInactivityStop(host);
        }
        if (gotFinal) {
          if (speechFinalizeTimer != null) {
            window.clearTimeout(speechFinalizeTimer);
          }
          speechFinalizeTimer = window.setTimeout(() => flushRecognizedText(host), 700);
        }
      };
      speechRecognition.onerror = () => {
        host.recording = false;
        speechRecognition = null;
        if (!host.voiceMode || speechStopRequested) {
          speechStopRequested = false;
          return;
        }
        scheduleSpeechRestart(host, 900);
      };
      speechRecognition.onend = () => {
        const wasStopRequested = speechStopRequested;
        speechStopRequested = false;
        clearSpeechTimers();
        speechRecognition = null;
        flushRecognizedText(host);
        if (host.voiceMode && !wasStopRequested) {
          scheduleSpeechRestart(host, 450);
          return;
        }
        host.recording = false;
      };
      speechRecognition.start();
      host.recording = true;
      scheduleSpeechInactivityStop(host);
      return;
    } catch {
      speechRecognition = null;
      speechTranscript = "";
    }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: "audio/webm;codecs=opus",
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      audioChunks = [];
      host.recording = false;
    };

    mediaRecorder.start();
    host.recording = true;
    scheduleSpeechInactivityStop(host);
  } catch (error) {
    console.error("Microphone access error:", error);
    host.recording = false;
  }
}

export function stopVoiceRecording(host: ChatHost) {
  clearSpeechTimers();
  speechStopRequested = true;
  if (speechRecognition) {
    speechRecognition.stop();
    host.recording = false;
    return;
  }
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  } else {
    host.recording = false;
  }
}
