import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import type { SessionsListResult } from "../types.ts";
import type { ChatItem, MessageGroup } from "../types/chat-types.ts";
import type { ChatAttachment, ChatQueueItem } from "../ui-types.ts";
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
} from "../chat/grouped-render.ts";
import { normalizeMessage, normalizeRoleForGrouping } from "../chat/message-normalizer.ts";
import { icons } from "../icons.ts";
import { detectTextDirection } from "../text-direction.ts";
import { renderMarkdownSidebar } from "./markdown-sidebar.ts";
import "../components/resizable-divider.ts";

export type CompactionIndicatorStatus = {
  active: boolean;
  startedAt: number | null;
  completedAt: number | null;
};

export type ChatProps = {
  sessionKey: string;
  onSessionKeyChange: (next: string) => void;
  thinkingLevel: string | null;
  showThinking: boolean;
  loading: boolean;
  sending: boolean;
  canAbort?: boolean;
  compactionStatus?: CompactionIndicatorStatus | null;
  messages: unknown[];
  toolMessages: unknown[];
  stream: string | null;
  streamStartedAt: number | null;
  assistantAvatarUrl?: string | null;
  draft: string;
  queue: ChatQueueItem[];
  connected: boolean;
  canSend: boolean;
  disabledReason: string | null;
  error: string | null;
  sessions: SessionsListResult | null;
  // Focus mode
  focusMode: boolean;
  // Sidebar state
  sidebarOpen?: boolean;
  sidebarContent?: string | null;
  sidebarError?: string | null;
  splitRatio?: number;
  assistantName: string;
  assistantAvatar: string | null;
  voiceOrbGifSrc?: string;
  // Image attachments
  attachments?: ChatAttachment[];
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void;
  // Scroll control
  showNewMessages?: boolean;
  onScrollToBottom?: () => void;
  // Voice mode
  voiceMode?: boolean;
  recording?: boolean;
  voicePlaybackLevel?: number;
  voicePlaybackActive?: boolean;
  onToggleVoiceMode?: () => void;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  ttsProvider?: "openai" | "elevenlabs" | "edge" | "unknown";
  ttsSwitching?: boolean;
  onSetTtsProvider?: (provider: "elevenlabs" | "edge") => void;
  textInputVisible?: boolean;
  onToggleTextInput?: () => void;
  displayName?: string;
  onOpenConfig?: () => void;
  // Event handlers
  onRefresh: () => void;
  onToggleFocusMode: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onAbort?: () => void;
  onQueueRemove: (id: string) => void;
  onNewSession: () => void;
  onOpenSidebar?: (content: string) => void;
  onCloseSidebar?: () => void;
  onSplitRatioChange?: (ratio: number) => void;
  onChatScroll?: (event: Event) => void;
};

const COMPACTION_TOAST_DURATION_MS = 5000;

function adjustTextareaHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function renderCompactionIndicator(status: CompactionIndicatorStatus | null | undefined) {
  if (!status) {
    return nothing;
  }

  // Show "compacting..." while active
  if (status.active) {
    return html`
      <div class="compaction-indicator compaction-indicator--active" role="status" aria-live="polite">
        ${icons.loader} Compacting context...
      </div>
    `;
  }

  // Show "compaction complete" briefly after completion
  if (status.completedAt) {
    const elapsed = Date.now() - status.completedAt;
    if (elapsed < COMPACTION_TOAST_DURATION_MS) {
      return html`
        <div class="compaction-indicator compaction-indicator--complete" role="status" aria-live="polite">
          ${icons.check} Context compacted
        </div>
      `;
    }
  }

  return nothing;
}

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function handlePaste(e: ClipboardEvent, props: ChatProps) {
  const items = e.clipboardData?.items;
  if (!items || !props.onAttachmentsChange) {
    return;
  }

  const imageItems: DataTransferItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith("image/")) {
      imageItems.push(item);
    }
  }

  if (imageItems.length === 0) {
    return;
  }

  e.preventDefault();

  for (const item of imageItems) {
    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = reader.result as string;
      const newAttachment: ChatAttachment = {
        id: generateAttachmentId(),
        dataUrl,
        mimeType: file.type,
      };
      const current = props.attachments ?? [];
      props.onAttachmentsChange?.([...current, newAttachment]);
    });
    reader.readAsDataURL(file);
  }
}

function renderAttachmentPreview(props: ChatProps) {
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    return nothing;
  }

  return html`
    <div class="chat-attachments">
      ${attachments.map(
        (att) => html`
          <div class="chat-attachment">
            <img
              src=${att.dataUrl}
              alt="Attachment preview"
              class="chat-attachment__img"
            />
            <button
              class="chat-attachment__remove"
              type="button"
              aria-label="Remove attachment"
              @click=${() => {
                const next = (props.attachments ?? []).filter((a) => a.id !== att.id);
                props.onAttachmentsChange?.(next);
              }}
            >
              ${icons.x}
            </button>
          </div>
        `,
      )}
    </div>
  `;
}

export function renderChat(props: ChatProps) {
  const canCompose = props.connected;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const reasoningLevel = activeSession?.reasoningLevel ?? "off";
  const showReasoning = props.showThinking && reasoningLevel !== "off";
  const assistantIdentity = {
    name: props.assistantName,
    avatar: props.assistantAvatar ?? props.assistantAvatarUrl ?? null,
  };

  const hasAttachments = (props.attachments?.length ?? 0) > 0;
  const composePlaceholder = props.connected
    ? hasAttachments
      ? "Agrega un mensaje o pega mas imagenes..."
      : "Mensaje (Enter para enviar, Shift+Enter para salto de linea, puedes pegar imagenes)"
    : "Conectate al gateway para empezar a chatear...";

  const splitRatio = props.splitRatio ?? 0.6;
  const sidebarOpen = Boolean(props.sidebarOpen && props.onCloseSidebar);
  const textInputVisible = props.textInputVisible ?? false;
  const voiceMode = props.voiceMode ?? false;
  const recording = props.recording ?? false;
  const voicePlaybackLevel = props.voicePlaybackLevel ?? 0;
  const voicePlaybackActive = props.voicePlaybackActive ?? false;
  const voiceOrbGifSrc = (props.voiceOrbGifSrc ?? "/voz.gif").trim() || "/voz.gif";
  const thread = html`
    <div class="chat-thread" role="log" aria-live="polite" @scroll=${props.onChatScroll}>
      ${
        props.loading
          ? html`
              <div class="muted">Cargando chat...</div>
            `
          : nothing
      }
      ${repeat(
        buildChatItems(props),
        (item) => item.key,
        (item) => {
          if (item.kind === "divider") {
            return html`
              <div class="chat-divider" role="separator" data-ts=${String(item.timestamp)}>
                <span class="chat-divider__line"></span>
                <span class="chat-divider__label">${item.label}</span>
                <span class="chat-divider__line"></span>
              </div>
            `;
          }

          if (item.kind === "reading-indicator") {
            return renderReadingIndicatorGroup(assistantIdentity);
          }

          if (item.kind === "stream") {
            return renderStreamingGroup(
              item.text,
              item.startedAt,
              props.onOpenSidebar,
              assistantIdentity,
            );
          }

          if (item.kind === "group") {
            return renderMessageGroup(item, {
              onOpenSidebar: props.onOpenSidebar,
              showReasoning,
              assistantName: props.assistantName,
              assistantAvatar: assistantIdentity.avatar,
            });
          }

          return nothing;
        },
      )}
    </div>
  `;

  return html`
    <section class="card chat ${voiceMode ? "chat--voice-mode" : ""}">
      ${props.disabledReason ? html`<div class="callout">${props.disabledReason}</div>` : nothing}
      ${props.error ? html`<div class="callout danger">${props.error}</div>` : nothing}

      ${
        props.focusMode
          ? html`
            <button
              class="chat-focus-exit"
              type="button"
              @click=${props.onToggleFocusMode}
              aria-label="Salir del modo enfoque"
              title="Salir del modo enfoque"
            >
              ${icons.x}
            </button>
          `
          : nothing
      }

      ${
        voiceMode
          ? html`
            <div class="voice-clean-stage">
              <div class="voice-clean-stage__orb-wrap" aria-hidden="true">
                <img class="voice-clean-stage__orb" src=${voiceOrbGifSrc} alt="Asistente" />
              </div>
              <div class="voice-visualizer" aria-hidden="true">
                ${Array.from({ length: 14 }, (_, i) => {
                  const wave = 0.3 + Math.abs(Math.sin(Date.now() / 230 + i * 0.8)) * 0.7;
                  const level = Math.max(0.09, voicePlaybackLevel);
                  const height = 20 + Math.round(72 * level * wave);
                  return html`
                    <span
                      class="voice-visualizer__bar ${voicePlaybackActive ? "active" : ""}"
                      style="height:${height}px"
                    ></span>
                  `;
                })}
              </div>
              <div class="voice-clean-stage__hint">
                ${recording ? "Escuchando continuamente" : "Activa el microfono para empezar"}
              </div>
              ${
                !recording && !voicePlaybackActive
                  ? html`
                    <button
                      class="voice-mic-trigger"
                      ?disabled=${!props.connected}
                      @click=${props.onStartRecording}
                      title="Activar microfono"
                      aria-label="Activar microfono"
                    >
                      ${icons.mic}
                    </button>
                  `
                  : nothing
              }
              <button class="voice-corner voice-corner--left" @click=${props.onOpenConfig} title="Ajustes" aria-label="Ajustes">
                ${icons.settings}
              </button>
              <button class="voice-corner voice-corner--right" @click=${props.onToggleVoiceMode} title="Ir al chat" aria-label="Ir al chat">
                ${icons.messageSquare}
              </button>
            </div>
          `
          : html`
            <div class="chat-split-container ${sidebarOpen ? "chat-split-container--open" : ""}">
              <div class="chat-main" style="flex: ${sidebarOpen ? `0 0 ${splitRatio * 100}%` : "1 1 100%"}">
                ${thread}
              </div>
              ${
                sidebarOpen
                  ? html`
                    <resizable-divider
                      .splitRatio=${splitRatio}
                      @resize=${(e: CustomEvent) => props.onSplitRatioChange?.(e.detail.splitRatio)}
                    ></resizable-divider>
                    <div class="chat-sidebar">
                      ${renderMarkdownSidebar({
                        content: props.sidebarContent ?? null,
                        error: props.sidebarError ?? null,
                        onClose: props.onCloseSidebar!,
                        onViewRawText: () => {
                          if (!props.sidebarContent || !props.onOpenSidebar) {
                            return;
                          }
                          props.onOpenSidebar(`\`\`\`\n${props.sidebarContent}\n\`\`\``);
                        },
                      })}
                    </div>
                  `
                  : nothing
              }
            </div>
          `
      }

      ${
        props.queue.length
          ? html`
            <div class="chat-queue" role="status" aria-live="polite">
              <div class="chat-queue__title">En cola (${props.queue.length})</div>
              <div class="chat-queue__list">
                ${props.queue.map(
                  (item) => html`
                    <div class="chat-queue__item">
                      <div class="chat-queue__text">
                        ${item.text || (item.attachments?.length ? `Imagen (${item.attachments.length})` : "")}
                      </div>
                      <button
                        class="btn chat-queue__remove"
                        type="button"
                        aria-label="Quitar mensaje en cola"
                        @click=${() => props.onQueueRemove(item.id)}
                      >
                        ${icons.x}
                      </button>
                    </div>
                  `,
                )}
              </div>
            </div>
          `
          : nothing
      }

      ${renderCompactionIndicator(props.compactionStatus)}

      ${
        props.showNewMessages
          ? html`
            <button class="btn chat-new-messages" type="button" @click=${props.onScrollToBottom}>
              Mensajes nuevos ${icons.arrowDown}
            </button>
          `
          : nothing
      }

      ${
        !voiceMode
          ? html`
            <div class="chat-compose">
              ${
                textInputVisible
                  ? html`
                      ${renderAttachmentPreview(props)}
                      <div class="chat-compose__row">
                        <label class="field chat-compose__field">
                          <span>Mensaje</span>
                          <textarea
                            ${ref((el) => el && adjustTextareaHeight(el as HTMLTextAreaElement))}
                            .value=${props.draft}
                            dir=${detectTextDirection(props.draft)}
                            ?disabled=${!props.connected}
                            @keydown=${(e: KeyboardEvent) => {
                              if (e.key !== "Enter") {
                                return;
                              }
                              if (e.isComposing || e.keyCode === 229) {
                                return;
                              }
                              if (e.shiftKey) {
                                return;
                              }
                              if (!props.connected) {
                                return;
                              }
                              e.preventDefault();
                              if (canCompose) {
                                props.onSend();
                              }
                            }}
                            @input=${(e: Event) => {
                              const target = e.target as HTMLTextAreaElement;
                              adjustTextareaHeight(target);
                              props.onDraftChange(target.value);
                            }}
                            @paste=${(e: ClipboardEvent) => handlePaste(e, props)}
                            placeholder=${composePlaceholder}
                          ></textarea>
                        </label>
                        <div class="chat-compose__actions">
                          <button class="btn btn--sm" @click=${props.onToggleTextInput}>Ocultar texto</button>
                          <button
                            class="btn"
                            ?disabled=${!props.connected || (!canAbort && props.sending)}
                            @click=${canAbort ? props.onAbort : props.onNewSession}
                          >
                            ${canAbort ? "Detener" : "Nueva sesion"}
                          </button>
                          <button class="btn primary" ?disabled=${!props.connected} @click=${props.onSend}>
                            ${isBusy ? "En cola" : "Enviar"}<kbd class="btn-kbd">↵</kbd>
                          </button>
                        </div>
                      </div>
                    `
                  : html`
                      <div class="chat-compose__minimal">
                        <button class="btn btn--sm subtle" @click=${props.onToggleTextInput}>Escribir mensaje</button>
                        <button class="btn btn--sm" @click=${props.onToggleVoiceMode}>Modo voz</button>
                      </div>
                    `
              }
            </div>
          `
          : nothing
      }
    </section>
  `;
}

const CHAT_HISTORY_RENDER_LIMIT = 200;

function groupMessages(items: ChatItem[]): Array<ChatItem | MessageGroup> {
  const result: Array<ChatItem | MessageGroup> = [];
  let currentGroup: MessageGroup | null = null;

  for (const item of items) {
    if (item.kind !== "message") {
      if (currentGroup) {
        result.push(currentGroup);
        currentGroup = null;
      }
      result.push(item);
      continue;
    }

    const normalized = normalizeMessage(item.message);
    const role = normalizeRoleForGrouping(normalized.role);
    const timestamp = normalized.timestamp || Date.now();

    if (!currentGroup || currentGroup.role !== role) {
      if (currentGroup) {
        result.push(currentGroup);
      }
      currentGroup = {
        kind: "group",
        key: `group:${role}:${item.key}`,
        role,
        messages: [{ message: item.message, key: item.key }],
        timestamp,
        isStreaming: false,
      };
    } else {
      currentGroup.messages.push({ message: item.message, key: item.key });
    }
  }

  if (currentGroup) {
    result.push(currentGroup);
  }
  return result;
}

function buildChatItems(props: ChatProps): Array<ChatItem | MessageGroup> {
  const items: ChatItem[] = [];
  const history = Array.isArray(props.messages) ? props.messages : [];
  const tools = Array.isArray(props.toolMessages) ? props.toolMessages : [];
  const historyStart = Math.max(0, history.length - CHAT_HISTORY_RENDER_LIMIT);
  if (historyStart > 0) {
    items.push({
      kind: "message",
      key: "chat:history:notice",
      message: {
        role: "system",
        content: `Showing last ${CHAT_HISTORY_RENDER_LIMIT} messages (${historyStart} hidden).`,
        timestamp: Date.now(),
      },
    });
  }
  for (let i = historyStart; i < history.length; i++) {
    const msg = history[i];
    const normalized = normalizeMessage(msg);
    const raw = msg as Record<string, unknown>;
    const marker = raw.__openclaw as Record<string, unknown> | undefined;
    if (marker && marker.kind === "compaction") {
      items.push({
        kind: "divider",
        key:
          typeof marker.id === "string"
            ? `divider:compaction:${marker.id}`
            : `divider:compaction:${normalized.timestamp}:${i}`,
        label: "Compaction",
        timestamp: normalized.timestamp ?? Date.now(),
      });
      continue;
    }

    if (!props.showThinking && normalized.role.toLowerCase() === "toolresult") {
      continue;
    }

    items.push({
      kind: "message",
      key: messageKey(msg, i),
      message: msg,
    });
  }
  if (props.showThinking) {
    for (let i = 0; i < tools.length; i++) {
      items.push({
        kind: "message",
        key: messageKey(tools[i], i + history.length),
        message: tools[i],
      });
    }
  }

  if (props.stream !== null) {
    const key = `stream:${props.sessionKey}:${props.streamStartedAt ?? "live"}`;
    if (props.stream.trim().length > 0) {
      items.push({
        kind: "stream",
        key,
        text: props.stream,
        startedAt: props.streamStartedAt ?? Date.now(),
      });
    } else {
      items.push({ kind: "reading-indicator", key });
    }
  }

  return groupMessages(items);
}

function messageKey(message: unknown, index: number): string {
  const m = message as Record<string, unknown>;
  const toolCallId = typeof m.toolCallId === "string" ? m.toolCallId : "";
  if (toolCallId) {
    return `tool:${toolCallId}`;
  }
  const id = typeof m.id === "string" ? m.id : "";
  if (id) {
    return `msg:${id}`;
  }
  const messageId = typeof m.messageId === "string" ? m.messageId : "";
  if (messageId) {
    return `msg:${messageId}`;
  }
  const timestamp = typeof m.timestamp === "number" ? m.timestamp : null;
  const role = typeof m.role === "string" ? m.role : "unknown";
  if (timestamp != null) {
    return `msg:${role}:${timestamp}:${index}`;
  }
  return `msg:${role}:${index}`;
}

