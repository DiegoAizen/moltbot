import { LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { EventLogEntry } from "./app-events.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { DevicePairingList } from "./controllers/devices.ts";
import type { ExecApprovalRequest } from "./controllers/exec-approval.ts";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./controllers/exec-approvals.ts";
import type { SkillMessage } from "./controllers/skills.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "./gateway.ts";
import type { Tab } from "./navigation.ts";
import type { ResolvedTheme, ThemeMode } from "./theme.ts";
import type {
  AgentsListResult,
  AgentsFilesListResult,
  AgentIdentityResult,
  ConfigSnapshot,
  ConfigUiHints,
  CronJob,
  CronRunLogEntry,
  CronStatus,
  HealthSnapshot,
  LogEntry,
  LogLevel,
  PresenceEntry,
  ChannelsStatusSnapshot,
  SessionsListResult,
  SkillStatusReport,
  StatusSummary,
  NostrProfile,
} from "./types.ts";
import type { NostrProfileFormState } from "./views/channels.nostr-profile-form.ts";
import {
  handleChannelConfigReload as handleChannelConfigReloadInternal,
  handleChannelConfigSave as handleChannelConfigSaveInternal,
  handleNostrProfileCancel as handleNostrProfileCancelInternal,
  handleNostrProfileEdit as handleNostrProfileEditInternal,
  handleNostrProfileFieldChange as handleNostrProfileFieldChangeInternal,
  handleNostrProfileImport as handleNostrProfileImportInternal,
  handleNostrProfileSave as handleNostrProfileSaveInternal,
  handleNostrProfileToggleAdvanced as handleNostrProfileToggleAdvancedInternal,
  handleWhatsAppLogout as handleWhatsAppLogoutInternal,
  handleWhatsAppStart as handleWhatsAppStartInternal,
  handleWhatsAppWait as handleWhatsAppWaitInternal,
} from "./app-channels.ts";
import {
  handleAbortChat as handleAbortChatInternal,
  handleSendChat as handleSendChatInternal,
  removeQueuedMessage as removeQueuedMessageInternal,
  toggleVoiceMode as toggleVoiceModeInternal,
  startVoiceRecording as startVoiceRecordingInternal,
  stopVoiceRecording as stopVoiceRecordingInternal,
} from "./app-chat.ts";
import { DEFAULT_CRON_FORM, DEFAULT_LOG_LEVEL_FILTERS } from "./app-defaults.ts";
import { connectGateway as connectGatewayInternal } from "./app-gateway.ts";
import {
  handleConnected,
  handleDisconnected,
  handleFirstUpdated,
  handleUpdated,
} from "./app-lifecycle.ts";
import { renderApp } from "./app-render.ts";
import {
  exportLogs as exportLogsInternal,
  handleChatScroll as handleChatScrollInternal,
  handleLogsScroll as handleLogsScrollInternal,
  resetChatScroll as resetChatScrollInternal,
  scheduleChatScroll as scheduleChatScrollInternal,
} from "./app-scroll.ts";
import {
  applySettings as applySettingsInternal,
  loadCron as loadCronInternal,
  loadOverview as loadOverviewInternal,
  setTab as setTabInternal,
  setTheme as setThemeInternal,
  onPopState as onPopStateInternal,
} from "./app-settings.ts";
import {
  resetToolStream as resetToolStreamInternal,
  type ToolStreamEntry,
  type CompactionStatus,
} from "./app-tool-stream.ts";
import {
  playAssistantVoiceFromText,
  prepareAssistantVoiceFromText,
  subscribeAssistantVoicePlayback,
  type PreparedAssistantVoice,
} from "./assistant-voice.ts";
import { resolveInjectedAssistantIdentity } from "./assistant-identity.ts";
import { loadAssistantIdentity as loadAssistantIdentityInternal } from "./controllers/assistant-identity.ts";
import { loadSettings, type UiSettings } from "./storage.ts";
import { type ChatAttachment, type ChatQueueItem, type CronFormState } from "./ui-types.ts";

type TtsProviderUi = "openai" | "elevenlabs" | "edge" | "unknown";

type TtsStatusResponse = {
  provider?: string;
};

type GreetingDiagnostics = {
  provider: TtsProviderUi;
  ttsConvert: "ok" | "fail" | "not-attempted";
  audioPlay: "ok" | "fail" | "not-attempted";
  fallbackSpeech: "ok" | "fail" | "not-attempted";
  mimeType: string | null;
  lastError: string | null;
};

declare global {
  interface Window {
    __OPENCLAW_CONTROL_UI_BASE_PATH__?: string;
  }
}

const injectedAssistantIdentity = resolveInjectedAssistantIdentity();

function resolveOnboardingMode(): boolean {
  if (!window.location.search) {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("onboarding");
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

@customElement("openclaw-app")
export class OpenClawApp extends LitElement {
  @state() settings: UiSettings = loadSettings();
  @state() password = "";
  @state() tab: Tab = "chat";
  @state() onboarding = resolveOnboardingMode();
  @state() connected = false;
  @state() theme: ThemeMode = this.settings.theme ?? "system";
  @state() themeResolved: ResolvedTheme = "dark";
  @state() hello: GatewayHelloOk | null = null;
  @state() lastError: string | null = null;
  @state() eventLog: EventLogEntry[] = [];
  private eventLogBuffer: EventLogEntry[] = [];
  private toolStreamSyncTimer: number | null = null;
  private sidebarCloseTimer: number | null = null;

  @state() assistantName = injectedAssistantIdentity.name;
  @state() assistantAvatar = injectedAssistantIdentity.avatar;
  @state() assistantAgentId = injectedAssistantIdentity.agentId ?? null;

  @state() sessionKey = this.settings.sessionKey;
  @state() chatLoading = false;
  @state() chatSending = false;
  @state() chatMessage = "";
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
  @state() chatStream: string | null = null;
  @state() chatStreamStartedAt: number | null = null;
  @state() chatRunId: string | null = null;
  @state() compactionStatus: CompactionStatus | null = null;
  @state() chatAvatarUrl: string | null = null;
  @state() chatThinkingLevel: string | null = null;
  @state() chatQueue: ChatQueueItem[] = [];
  @state() chatAttachments: ChatAttachment[] = [];
  @state() chatManualRefreshInFlight = false;
  @state() voiceMode = false;
  @state() recording = false;
  @state() voicePlaybackLevel = 0;
  @state() voicePlaybackActive = false;
  @state() greetingVisible = false;
  @state() greetingNeedsInteraction = false;
  @state() greetingDiagnosticsVisible = false;
  @state() greetingDiagnostics: GreetingDiagnostics = {
    provider: "unknown",
    ttsConvert: "not-attempted",
    audioPlay: "not-attempted",
    fallbackSpeech: "not-attempted",
    mimeType: null,
    lastError: null,
  };
  @state() bootSplashVisible =
    this.settings.profileReady && this.settings.profileName.trim().length > 0;
  @state() bootSplashClosing = false;
  @state() ttsProvider: TtsProviderUi = "unknown";
  @state() ttsSwitching = false;
  // Sidebar state for tool output viewing
  @state() sidebarOpen = false;
  @state() sidebarContent: string | null = null;
  @state() sidebarError: string | null = null;
  @state() splitRatio = this.settings.splitRatio;

  @state() nodesLoading = false;
  @state() nodes: Array<Record<string, unknown>> = [];
  @state() devicesLoading = false;
  @state() devicesError: string | null = null;
  @state() devicesList: DevicePairingList | null = null;
  @state() execApprovalsLoading = false;
  @state() execApprovalsSaving = false;
  @state() execApprovalsDirty = false;
  @state() execApprovalsSnapshot: ExecApprovalsSnapshot | null = null;
  @state() execApprovalsForm: ExecApprovalsFile | null = null;
  @state() execApprovalsSelectedAgent: string | null = null;
  @state() execApprovalsTarget: "gateway" | "node" = "gateway";
  @state() execApprovalsTargetNodeId: string | null = null;
  @state() execApprovalQueue: ExecApprovalRequest[] = [];
  @state() execApprovalBusy = false;
  @state() execApprovalError: string | null = null;
  @state() pendingGatewayUrl: string | null = null;

  @state() configLoading = false;
  @state() configRaw = "{\n}\n";
  @state() configRawOriginal = "";
  @state() configValid: boolean | null = null;
  @state() configIssues: unknown[] = [];
  @state() configSaving = false;
  @state() configApplying = false;
  @state() configResetting = false;
  @state() updateRunning = false;
  @state() spotifyConnecting = false;
  @state() spotifyStatus: string | null = null;
  @state() applySessionKey = this.settings.lastActiveSessionKey;
  @state() configSnapshot: ConfigSnapshot | null = null;
  @state() configSchema: unknown = null;
  @state() configSchemaVersion: string | null = null;
  @state() configSchemaLoading = false;
  @state() configUiHints: ConfigUiHints = {};
  @state() configForm: Record<string, unknown> | null = null;
  @state() configFormOriginal: Record<string, unknown> | null = null;
  @state() configFormDirty = false;
  @state() configFormMode: "form" | "raw" = "form";
  @state() configSearchQuery = "";
  @state() configActiveSection: string | null = null;
  @state() configActiveSubsection: string | null = null;

  @state() channelsLoading = false;
  @state() channelsSnapshot: ChannelsStatusSnapshot | null = null;
  @state() channelsError: string | null = null;
  @state() channelsLastSuccess: number | null = null;
  @state() whatsappLoginMessage: string | null = null;
  @state() whatsappLoginQrDataUrl: string | null = null;
  @state() whatsappLoginConnected: boolean | null = null;
  @state() whatsappBusy = false;
  @state() nostrProfileFormState: NostrProfileFormState | null = null;
  @state() nostrProfileAccountId: string | null = null;

  @state() presenceLoading = false;
  @state() presenceEntries: PresenceEntry[] = [];
  @state() presenceError: string | null = null;
  @state() presenceStatus: string | null = null;

  @state() agentsLoading = false;
  @state() agentsList: AgentsListResult | null = null;
  @state() agentsError: string | null = null;
  @state() agentsSelectedId: string | null = null;
  @state() agentsPanel: "overview" | "files" | "tools" | "skills" | "channels" | "cron" =
    "overview";
  @state() agentFilesLoading = false;
  @state() agentFilesError: string | null = null;
  @state() agentFilesList: AgentsFilesListResult | null = null;
  @state() agentFileContents: Record<string, string> = {};
  @state() agentFileDrafts: Record<string, string> = {};
  @state() agentFileActive: string | null = null;
  @state() agentFileSaving = false;
  @state() agentIdentityLoading = false;
  @state() agentIdentityError: string | null = null;
  @state() agentIdentityById: Record<string, AgentIdentityResult> = {};
  @state() agentSkillsLoading = false;
  @state() agentSkillsError: string | null = null;
  @state() agentSkillsReport: SkillStatusReport | null = null;
  @state() agentSkillsAgentId: string | null = null;

  @state() sessionsLoading = false;
  @state() sessionsResult: SessionsListResult | null = null;
  @state() sessionsError: string | null = null;
  @state() sessionsFilterActive = "";
  @state() sessionsFilterLimit = "120";
  @state() sessionsIncludeGlobal = true;
  @state() sessionsIncludeUnknown = false;

  @state() usageLoading = false;
  @state() usageResult: import("./types.js").SessionsUsageResult | null = null;
  @state() usageCostSummary: import("./types.js").CostUsageSummary | null = null;
  @state() usageError: string | null = null;
  @state() usageStartDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageEndDate = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  @state() usageSelectedSessions: string[] = [];
  @state() usageSelectedDays: string[] = [];
  @state() usageSelectedHours: number[] = [];
  @state() usageChartMode: "tokens" | "cost" = "tokens";
  @state() usageDailyChartMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeriesMode: "cumulative" | "per-turn" = "per-turn";
  @state() usageTimeSeriesBreakdownMode: "total" | "by-type" = "by-type";
  @state() usageTimeSeries: import("./types.js").SessionUsageTimeSeries | null = null;
  @state() usageTimeSeriesLoading = false;
  @state() usageSessionLogs: import("./views/usage.js").SessionLogEntry[] | null = null;
  @state() usageSessionLogsLoading = false;
  @state() usageSessionLogsExpanded = false;
  // Applied query (used to filter the already-loaded sessions list client-side).
  @state() usageQuery = "";
  // Draft query text (updates immediately as the user types; applied via debounce or "Search").
  @state() usageQueryDraft = "";
  @state() usageSessionSort: "tokens" | "cost" | "recent" | "messages" | "errors" = "recent";
  @state() usageSessionSortDir: "desc" | "asc" = "desc";
  @state() usageRecentSessions: string[] = [];
  @state() usageTimeZone: "local" | "utc" = "local";
  @state() usageContextExpanded = false;
  @state() usageHeaderPinned = false;
  @state() usageSessionsTab: "all" | "recent" = "all";
  @state() usageVisibleColumns: string[] = [
    "channel",
    "agent",
    "provider",
    "model",
    "messages",
    "tools",
    "errors",
    "duration",
  ];
  @state() usageLogFilterRoles: import("./views/usage.js").SessionLogRole[] = [];
  @state() usageLogFilterTools: string[] = [];
  @state() usageLogFilterHasTools = false;
  @state() usageLogFilterQuery = "";

  // Non-reactive (don’t trigger renders just for timer bookkeeping).
  usageQueryDebounceTimer: number | null = null;

  @state() cronLoading = false;
  @state() cronJobs: CronJob[] = [];
  @state() cronStatus: CronStatus | null = null;
  @state() cronError: string | null = null;
  @state() cronForm: CronFormState = { ...DEFAULT_CRON_FORM };
  @state() cronRunsJobId: string | null = null;
  @state() cronRuns: CronRunLogEntry[] = [];
  @state() cronBusy = false;

  @state() skillsLoading = false;
  @state() skillsReport: SkillStatusReport | null = null;
  @state() skillsError: string | null = null;
  @state() skillsFilter = "";
  @state() skillEdits: Record<string, string> = {};
  @state() skillsBusyKey: string | null = null;
  @state() skillMessages: Record<string, SkillMessage> = {};

  @state() debugLoading = false;
  @state() debugStatus: StatusSummary | null = null;
  @state() debugHealth: HealthSnapshot | null = null;
  @state() debugModels: unknown[] = [];
  @state() debugHeartbeat: unknown = null;
  @state() debugCallMethod = "";
  @state() debugCallParams = "{}";
  @state() debugCallResult: string | null = null;
  @state() debugCallError: string | null = null;

  @state() logsLoading = false;
  @state() logsError: string | null = null;
  @state() logsFile: string | null = null;
  @state() logsEntries: LogEntry[] = [];
  @state() logsFilterText = "";
  @state() logsLevelFilters: Record<LogLevel, boolean> = {
    ...DEFAULT_LOG_LEVEL_FILTERS,
  };
  @state() logsAutoFollow = true;
  @state() logsTruncated = false;
  @state() logsCursor: number | null = null;
  @state() logsLastFetchAt: number | null = null;
  @state() logsLimit = 500;
  @state() logsMaxBytes = 250_000;
  @state() logsAtBottom = true;

  client: GatewayBrowserClient | null = null;
  private chatScrollFrame: number | null = null;
  private chatScrollTimeout: number | null = null;
  private chatHasAutoScrolled = false;
  private chatUserNearBottom = true;
  @state() chatNewMessagesBelow = false;
  private nodesPollInterval: number | null = null;
  private logsPollInterval: number | null = null;
  private debugPollInterval: number | null = null;
  private logsScrollFrame: number | null = null;
  private toolStreamById = new Map<string, ToolStreamEntry>();
  private toolStreamOrder: string[] = [];
  refreshSessionsAfterChat = new Set<string>();
  basePath = "";
  private popStateHandler = () =>
    onPopStateInternal(this as unknown as Parameters<typeof onPopStateInternal>[0]);
  private themeMedia: MediaQueryList | null = null;
  private themeMediaHandler: ((event: MediaQueryListEvent) => void) | null = null;
  private topbarObserver: ResizeObserver | null = null;
  private stopVoicePlaybackSubscription: (() => void) | null = null;
  private greetingTimer: number | null = null;
  private greetingStarting = false;
  private greetingPreparedAudio: PreparedAssistantVoice | null = null;
  private bootSequenceRunning = false;
  private bootSequenceId = 0;
  private greetedThisLaunch = false;
  private resumeVoiceAfterPlayback = false;
  private lastVoiceUiSampleAt = 0;
  private lastVoiceUiLevel = 0;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.stopVoicePlaybackSubscription = subscribeAssistantVoicePlayback((level, playing) => {
      const wasPlaying = this.voicePlaybackActive;
      const now = Date.now();
      if (playing && this.recording) {
        this.resumeVoiceAfterPlayback = this.voiceMode;
        stopVoiceRecordingInternal(
          this as unknown as Parameters<typeof stopVoiceRecordingInternal>[0],
        );
      }
      if (!playing) {
        if (this.voicePlaybackActive || this.voicePlaybackLevel !== 0) {
          this.voicePlaybackLevel = 0;
          this.voicePlaybackActive = false;
        }
        if (!this.voiceMode) {
          this.resumeVoiceAfterPlayback = false;
        }
        if (this.resumeVoiceAfterPlayback && this.voiceMode && !this.recording) {
          this.resumeVoiceAfterPlayback = false;
          void startVoiceRecordingInternal(
            this as unknown as Parameters<typeof startVoiceRecordingInternal>[0],
          );
        }
      } else {
        this.greetingNeedsInteraction = false;
        const quantized = Math.round(Math.max(0, Math.min(1, level)) * 14) / 14;
        if (
          now - this.lastVoiceUiSampleAt < 80 &&
          Math.abs(quantized - this.lastVoiceUiLevel) < 0.06 &&
          this.voicePlaybackActive
        ) {
          return;
        }
        this.lastVoiceUiSampleAt = now;
        this.lastVoiceUiLevel = quantized;
        this.voicePlaybackLevel = quantized;
        this.voicePlaybackActive = true;
      }
    });
    handleConnected(this as unknown as Parameters<typeof handleConnected>[0]);
  }

  protected firstUpdated() {
    handleFirstUpdated(this as unknown as Parameters<typeof handleFirstUpdated>[0]);
  }

  disconnectedCallback() {
    if (this.greetingTimer != null) {
      window.clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
    this.bootSequenceId += 1;
    this.bootSequenceRunning = false;
    this.greetingPreparedAudio = null;
    this.stopVoicePlaybackSubscription?.();
    this.stopVoicePlaybackSubscription = null;
    handleDisconnected(this as unknown as Parameters<typeof handleDisconnected>[0]);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<PropertyKey, unknown>) {
    handleUpdated(this as unknown as Parameters<typeof handleUpdated>[0], changed);
    if (
      changed.has("connected") ||
      changed.has("settings") ||
      changed.has("onboarding") ||
      changed.has("tab")
    ) {
      this.maybeShowGreeting();
    }
  }

  private resetGreetingDiagnostics() {
    this.greetingDiagnostics = {
      provider: this.ttsProvider,
      ttsConvert: "not-attempted",
      audioPlay: "not-attempted",
      fallbackSpeech: "not-attempted",
      mimeType: null,
      lastError: null,
    };
    this.greetingDiagnosticsVisible = false;
  }

  private updateGreetingDiagnostics(patch: Partial<GreetingDiagnostics>) {
    this.greetingDiagnostics = {
      ...this.greetingDiagnostics,
      ...patch,
    };
  }

  private async trySpeechSynthesisFallback(text: string): Promise<boolean> {
    const synth = window.speechSynthesis;
    if (!synth) {
      this.updateGreetingDiagnostics({
        fallbackSpeech: "fail",
        lastError: "speechSynthesis no disponible",
      });
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "es-CO";
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onstart = () => {
        this.updateGreetingDiagnostics({ fallbackSpeech: "ok", lastError: null });
        this.voicePlaybackLevel = 0.18;
        this.voicePlaybackActive = true;
      };
      utterance.onend = () => {
        this.voicePlaybackLevel = 0;
        this.voicePlaybackActive = false;
        resolve(true);
      };
      utterance.onerror = () => {
        this.voicePlaybackLevel = 0;
        this.voicePlaybackActive = false;
        this.updateGreetingDiagnostics({
          fallbackSpeech: "fail",
          lastError: "speechSynthesis falló",
        });
        resolve(false);
      };
      try {
        synth.cancel();
        synth.speak(utterance);
      } catch {
        this.updateGreetingDiagnostics({
          fallbackSpeech: "fail",
          lastError: "speechSynthesis lanzó excepción",
        });
        resolve(false);
      }
    });
  }

  private hideGreetingOverlay() {
    if (!this.greetingVisible) {
      return;
    }
    if (this.greetingTimer != null) {
      window.clearTimeout(this.greetingTimer);
      this.greetingTimer = null;
    }
    this.greetingVisible = false;
    if (this.resumeVoiceAfterPlayback && this.voiceMode && !this.recording) {
      this.resumeVoiceAfterPlayback = false;
      void startVoiceRecordingInternal(
        this as unknown as Parameters<typeof startVoiceRecordingInternal>[0],
      );
    }
  }

  private showBootSplash() {
    this.greetingVisible = false;
    this.greetingNeedsInteraction = false;
    this.resetGreetingDiagnostics();
    this.bootSplashVisible = true;
    this.bootSplashClosing = false;
  }

  private async wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  private async preloadGreetingAudio(text: string): Promise<boolean> {
    if (!this.client) {
      this.updateGreetingDiagnostics({
        ttsConvert: "fail",
        lastError: "Gateway client no conectado",
      });
      return false;
    }
    // Force Edge for startup greeting reliability in desktop app mode.
    try {
      await this.client.request("tts.setProvider", { provider: "edge" });
      this.ttsProvider = "edge";
    } catch {
      // Keep current provider if setProvider is unavailable.
    }
    this.updateGreetingDiagnostics({ provider: this.ttsProvider });
    this.greetingPreparedAudio = await prepareAssistantVoiceFromText(this.client, text);
    const prepared = Boolean(this.greetingPreparedAudio);
    this.updateGreetingDiagnostics({
      ttsConvert: prepared ? "ok" : "fail",
      mimeType: this.greetingPreparedAudio?.mimeType ?? null,
      lastError: prepared ? null : "tts.convert devolvió audio vacío o inválido",
    });
    return prepared;
  }

  private async runBootGreetingSequence() {
    if (this.bootSequenceRunning || this.greetedThisLaunch) {
      return;
    }
    const hasProfile = this.settings.profileReady && this.settings.profileName.trim().length > 0;
    if (!hasProfile || !this.connected || this.onboarding) {
      return;
    }

    this.bootSequenceRunning = true;
    const sequenceId = ++this.bootSequenceId;
    this.greetingStarting = true;
    this.showBootSplash();

    const name = this.settings.profileName.trim();
    const text = name
      ? `Hola ${name}. Que gusto verte de nuevo.`
      : "Hola. Que gusto verte de nuevo.";

    // Phase 1: show loading splash for 6 seconds.
    await this.wait(6000);
    if (sequenceId !== this.bootSequenceId || !this.connected) {
      this.bootSequenceRunning = false;
      this.greetingStarting = false;
      return;
    }

    // Phase 2: keep splash visible until greeting audio is prepared.
    this.greetingPreparedAudio = null;
    await this.preloadGreetingAudio(text);
    if (sequenceId !== this.bootSequenceId || !this.connected) {
      this.bootSequenceRunning = false;
      this.greetingStarting = false;
      return;
    }

    this.bootSplashClosing = true;
    await this.wait(520);
    if (sequenceId !== this.bootSequenceId || !this.connected) {
      this.bootSequenceRunning = false;
      this.greetingStarting = false;
      return;
    }
    this.bootSplashVisible = false;
    this.bootSplashClosing = false;

    this.greetingVisible = true;
    this.greetingNeedsInteraction = false;

    let played = false;
    const preparedGreetingAudio = this.greetingPreparedAudio as PreparedAssistantVoice | null;
    if (preparedGreetingAudio) {
      played = await preparedGreetingAudio.play();
      this.updateGreetingDiagnostics({ audioPlay: played ? "ok" : "fail" });
    } else {
      played = await playAssistantVoiceFromText(this.client, text);
      this.updateGreetingDiagnostics({ audioPlay: played ? "ok" : "fail" });
    }
    if (!played) {
      // Retry once after a short delay in case audio subsystem needs an extra tick.
      await this.wait(320);
      played = await playAssistantVoiceFromText(this.client, text);
      this.updateGreetingDiagnostics({ audioPlay: played ? "ok" : "fail" });
    }
    if (!played) {
      const fallbackPlayed = await this.trySpeechSynthesisFallback(text);
      played = fallbackPlayed;
      this.greetingNeedsInteraction = !fallbackPlayed;
      this.greetingDiagnosticsVisible = true;
    } else {
      this.greetingNeedsInteraction = false;
      this.greetingDiagnosticsVisible = false;
    }

    await this.wait(played ? 4200 : 2600);
    if (sequenceId !== this.bootSequenceId) {
      this.bootSequenceRunning = false;
      this.greetingStarting = false;
      return;
    }
    this.hideGreetingOverlay();
    this.voiceMode = true;
    if (this.tab !== "chat") {
      this.setTab("chat");
    }
    void startVoiceRecordingInternal(this as unknown as Parameters<typeof startVoiceRecordingInternal>[0]);
    this.greetedThisLaunch = true;
    this.bootSequenceRunning = false;
    this.greetingStarting = false;
  }

  private maybeShowGreeting() {
    const hasProfile = this.settings.profileReady && this.settings.profileName.trim().length > 0;
    if (!hasProfile) {
      this.greetedThisLaunch = false;
      this.greetingStarting = false;
      this.bootSequenceRunning = false;
      this.bootSequenceId += 1;
      this.greetingPreparedAudio = null;
      this.bootSplashVisible = false;
      this.bootSplashClosing = false;
      this.hideGreetingOverlay();
      return;
    }
    if (!this.connected || this.onboarding || this.greetedThisLaunch) {
      return;
    }
    void this.runBootGreetingSequence();
  }

  handleReplayGreeting() {
    const prepared = this.greetingPreparedAudio;
    if (prepared) {
      this.greetingNeedsInteraction = false;
      this.greetingDiagnosticsVisible = false;
      this.updateGreetingDiagnostics({
        ttsConvert: "ok",
        mimeType: prepared.mimeType,
        provider: this.ttsProvider,
      });
      void prepared.play().then((ok) => {
        this.updateGreetingDiagnostics({ audioPlay: ok ? "ok" : "fail" });
        if (!ok && this.greetingVisible) {
          this.greetingNeedsInteraction = true;
          this.greetingDiagnosticsVisible = true;
        }
      });
      return;
    }
    const name = this.settings.profileName.trim();
    const text = name
      ? `Hola ${name}. Que gusto verte de nuevo.`
      : "Hola. Que gusto verte de nuevo.";
    this.greetingNeedsInteraction = false;
    void playAssistantVoiceFromText(this.client, text).then((ok) => {
      this.updateGreetingDiagnostics({ audioPlay: ok ? "ok" : "fail", provider: this.ttsProvider });
      if (!ok) {
        this.greetingNeedsInteraction = true;
        this.greetingDiagnosticsVisible = true;
      }
    });
  }

  private normalizeTtsProvider(value: unknown): TtsProviderUi {
    if (value === "openai" || value === "elevenlabs" || value === "edge") {
      return value;
    }
    return "unknown";
  }

  async refreshTtsProvider() {
    if (!this.client || !this.connected) {
      return;
    }
    try {
      const status = await this.client.request<TtsStatusResponse>("tts.status");
      const provider = this.normalizeTtsProvider(status?.provider);
      if (provider !== "edge") {
        await this.client.request("tts.setProvider", { provider: "edge" });
        this.ttsProvider = "edge";
        return;
      }
      this.ttsProvider = provider;
    } catch {
      // Keep current value; status polling should not break chat flow.
    }
  }

  async handleSetTtsProvider(_provider: "elevenlabs" | "edge") {
    if (!this.client || !this.connected || this.ttsSwitching) {
      return;
    }
    this.ttsSwitching = true;
    try {
      const forcedProvider = "edge";
      await this.client.request("tts.setProvider", { provider: forcedProvider });
      this.ttsProvider = forcedProvider;
      this.lastError = null;
      await this.refreshTtsProvider();
    } catch (err) {
      this.lastError = `No se pudo cambiar el proveedor de voz: ${String(err)}`;
    } finally {
      this.ttsSwitching = false;
    }
  }

  connect() {
    connectGatewayInternal(this as unknown as Parameters<typeof connectGatewayInternal>[0]);
  }

  handleChatScroll(event: Event) {
    handleChatScrollInternal(
      this as unknown as Parameters<typeof handleChatScrollInternal>[0],
      event,
    );
  }

  handleLogsScroll(event: Event) {
    handleLogsScrollInternal(
      this as unknown as Parameters<typeof handleLogsScrollInternal>[0],
      event,
    );
  }

  exportLogs(lines: string[], label: string) {
    exportLogsInternal(lines, label);
  }

  resetToolStream() {
    resetToolStreamInternal(this as unknown as Parameters<typeof resetToolStreamInternal>[0]);
  }

  resetChatScroll() {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
  }

  scrollToBottom(opts?: { smooth?: boolean }) {
    resetChatScrollInternal(this as unknown as Parameters<typeof resetChatScrollInternal>[0]);
    scheduleChatScrollInternal(
      this as unknown as Parameters<typeof scheduleChatScrollInternal>[0],
      true,
      Boolean(opts?.smooth),
    );
  }

  async loadAssistantIdentity() {
    await loadAssistantIdentityInternal(this);
  }

  applySettings(next: UiSettings) {
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], next);
  }

  setTab(next: Tab) {
    setTabInternal(this as unknown as Parameters<typeof setTabInternal>[0], next);
  }

  setTheme(next: ThemeMode, context?: Parameters<typeof setThemeInternal>[2]) {
    setThemeInternal(this as unknown as Parameters<typeof setThemeInternal>[0], next, context);
  }

  async loadOverview() {
    await loadOverviewInternal(this as unknown as Parameters<typeof loadOverviewInternal>[0]);
  }

  async loadCron() {
    await loadCronInternal(this as unknown as Parameters<typeof loadCronInternal>[0]);
  }

  async handleAbortChat() {
    await handleAbortChatInternal(this as unknown as Parameters<typeof handleAbortChatInternal>[0]);
  }

  removeQueuedMessage(id: string) {
    removeQueuedMessageInternal(
      this as unknown as Parameters<typeof removeQueuedMessageInternal>[0],
      id,
    );
  }

  async handleSendChat(
    messageOverride?: string,
    opts?: Parameters<typeof handleSendChatInternal>[2],
  ) {
    await handleSendChatInternal(
      this as unknown as Parameters<typeof handleSendChatInternal>[0],
      messageOverride,
      opts,
    );
  }

  handleToggleVoiceMode() {
    toggleVoiceModeInternal(this as unknown as Parameters<typeof toggleVoiceModeInternal>[0]);
    if (!this.voiceMode) {
      this.resumeVoiceAfterPlayback = false;
    }
  }

  async handleStartRecording() {
    await startVoiceRecordingInternal(this as unknown as Parameters<typeof startVoiceRecordingInternal>[0]);
  }

  handleStopRecording() {
    stopVoiceRecordingInternal(this as unknown as Parameters<typeof stopVoiceRecordingInternal>[0]);
  }

  async handleWhatsAppStart(force: boolean) {
    await handleWhatsAppStartInternal(this, force);
  }

  async handleWhatsAppWait() {
    await handleWhatsAppWaitInternal(this);
  }

  async handleWhatsAppLogout() {
    await handleWhatsAppLogoutInternal(this);
  }

  async handleChannelConfigSave() {
    await handleChannelConfigSaveInternal(this);
  }

  async handleChannelConfigReload() {
    await handleChannelConfigReloadInternal(this);
  }

  handleNostrProfileEdit(accountId: string, profile: NostrProfile | null) {
    handleNostrProfileEditInternal(this, accountId, profile);
  }

  handleNostrProfileCancel() {
    handleNostrProfileCancelInternal(this);
  }

  handleNostrProfileFieldChange(field: keyof NostrProfile, value: string) {
    handleNostrProfileFieldChangeInternal(this, field, value);
  }

  async handleNostrProfileSave() {
    await handleNostrProfileSaveInternal(this);
  }

  async handleNostrProfileImport() {
    await handleNostrProfileImportInternal(this);
  }

  handleNostrProfileToggleAdvanced() {
    handleNostrProfileToggleAdvancedInternal(this);
  }

  async handleExecApprovalDecision(decision: "allow-once" | "allow-always" | "deny") {
    const active = this.execApprovalQueue[0];
    if (!active || !this.client || this.execApprovalBusy) {
      return;
    }
    this.execApprovalBusy = true;
    this.execApprovalError = null;
    try {
      await this.client.request("exec.approval.resolve", {
        id: active.id,
        decision,
      });
      this.execApprovalQueue = this.execApprovalQueue.filter((entry) => entry.id !== active.id);
    } catch (err) {
      this.execApprovalError = `Exec approval failed: ${String(err)}`;
    } finally {
      this.execApprovalBusy = false;
    }
  }

  handleGatewayUrlConfirm() {
    const nextGatewayUrl = this.pendingGatewayUrl;
    if (!nextGatewayUrl) {
      return;
    }
    this.pendingGatewayUrl = null;
    applySettingsInternal(this as unknown as Parameters<typeof applySettingsInternal>[0], {
      ...this.settings,
      gatewayUrl: nextGatewayUrl,
    });
    this.connect();
  }

  handleGatewayUrlCancel() {
    this.pendingGatewayUrl = null;
  }

  async handleResetConfiguration() {
    if (!this.client || !this.connected || this.configResetting) {
      return;
    }
    const baseHash = this.configSnapshot?.hash;
    if (!baseHash) {
      this.lastError = "Config hash missing; reload and retry.";
      return;
    }

    this.configResetting = true;
    this.lastError = null;
    try {
      await this.client.request("config.apply", {
        raw: "{}\n",
        baseHash,
        sessionKey: this.applySessionKey,
      });
      this.applySettings({
        ...this.settings,
        token: "",
        sessionKey: "main",
        lastActiveSessionKey: "main",
        profileName: "",
        profileReady: false,
        textInputVisible: false,
        showAdvancedNav: false,
        navCollapsed: false,
      });
      this.greetedThisLaunch = false;
      this.hideGreetingOverlay();
      this.sessionKey = "main";
      this.chatMessage = "";
      this.chatAttachments = [];
      this.chatQueue = [];
      this.chatRunId = null;
      this.chatStream = null;
      this.chatStreamStartedAt = null;
      this.setTab("chat");
      window.setTimeout(() => this.connect(), 300);
    } catch (err) {
      this.lastError = `Reset failed: ${String(err)}`;
    } finally {
      this.configResetting = false;
    }
  }

  async handleConnectSpotify() {
    if (!this.connected || this.spotifyConnecting || !this.client) {
      return;
    }
    this.spotifyConnecting = true;
    this.spotifyStatus = "Iniciando conexión de Spotify...";
    this.lastError = null;
    try {
      const result = await this.client.request<{
        ok?: boolean;
        message?: string;
        requiresConnection?: boolean;
        connectUrl?: string | null;
      }>("spotify.connect", {
        sessionKey: this.sessionKey,
      });
      const baseMessage = result?.message?.trim() || "Listo, Spotify conectado.";
      this.spotifyStatus = result?.connectUrl ? `${baseMessage} ${result.connectUrl}` : baseMessage;
    } catch (err) {
      const raw = String(err);
      const message =
        raw.toLowerCase().includes("unauthorized")
          ? "Sin autorización del gateway. Revisa token/password en Settings."
          : `Conexión Spotify falló: ${raw}`;
      this.spotifyStatus = message;
      this.lastError = message;
    } finally {
      this.spotifyConnecting = false;
    }
  }

  // Sidebar handlers for tool output viewing
  handleOpenSidebar(content: string) {
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
      this.sidebarCloseTimer = null;
    }
    this.sidebarContent = content;
    this.sidebarError = null;
    this.sidebarOpen = true;
  }

  handleCloseSidebar() {
    this.sidebarOpen = false;
    // Clear content after transition
    if (this.sidebarCloseTimer != null) {
      window.clearTimeout(this.sidebarCloseTimer);
    }
    this.sidebarCloseTimer = window.setTimeout(() => {
      if (this.sidebarOpen) {
        return;
      }
      this.sidebarContent = null;
      this.sidebarError = null;
      this.sidebarCloseTimer = null;
    }, 200);
  }

  handleSplitRatioChange(ratio: number) {
    const newRatio = Math.max(0.4, Math.min(0.7, ratio));
    this.splitRatio = newRatio;
    this.applySettings({ ...this.settings, splitRatio: newRatio });
  }

  render() {
    return renderApp(this as unknown as AppViewState);
  }
}
