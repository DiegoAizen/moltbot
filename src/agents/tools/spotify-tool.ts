import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveOAuthDir } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { loadConfig } from "../../config/config.js";
import { waitForSpotifyOAuthCallback } from "../../gateway/spotify-oauth-callback.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { ToolInputError, jsonResult, readNumberParam, readStringParam } from "./common.js";

const SPOTIFY_ACTIONS = [
  "search",
  "play",
  "pause",
  "next",
  "previous",
  "devices",
  "status",
  "connect",
] as const;

const SPOTIFY_SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
] as const;

const SPOTIFY_CONNECTIONS_FILENAME = "spotify-connections.json";

const SpotifyToolSchema = Type.Object({
  action: stringEnum(SPOTIFY_ACTIONS),
  query: Type.Optional(Type.String({ description: "Search text (song/artist/album)." })),
  uri: Type.Optional(
    Type.String({
      description: "Spotify URI (spotify:track:... | spotify:album:... | spotify:playlist:...).",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max search results (1-10).",
      minimum: 1,
      maximum: 10,
    }),
  ),
  deviceId: Type.Optional(
    Type.String({
      description: "Optional target Spotify device id for playback commands.",
    }),
  ),
});

type SpotifyConfig = {
  enabled?: boolean;
  redirectUri?: string;
  market?: string;
  defaultDeviceId?: string;
  autoPlayOnOpen?: boolean;
};

type SpotifyTrack = {
  id: string;
  name: string;
  uri: string;
  url: string;
  artists: string[];
  album?: string;
};

type SpotifyConnectionEntry = {
  spotifyUserId: string;
  refreshTokenEncrypted: string;
  scopes: string[];
  connectedAt: number;
};

type SpotifyConnectionsStore = {
  version: number;
  users: Record<string, SpotifyConnectionEntry>;
};

type ConnectResult =
  | { ok: true; refreshedFromStore: boolean }
  | { ok: false; code: "missing_app_credentials" | "browser_open_failed" | "callback_timeout" | "oauth_failed"; message: string; connectUrl?: string };

function resolveSpotifyConfig(cfg?: OpenClawConfig): SpotifyConfig {
  const spotify = cfg?.tools?.music?.spotify;
  if (!spotify || typeof spotify !== "object") {
    return {};
  }
  return spotify;
}

function resolveOAuthRedirectUri(config: SpotifyConfig, cfg?: OpenClawConfig): string {
  const fromConfig = config.redirectUri?.trim();
  const fromEnv = process.env.SPOTIFY_REDIRECT_URI?.trim();
  const gatewayPort = cfg?.gateway?.port;
  const fallbackPort = Number.isFinite(gatewayPort) ? Number(gatewayPort) : 18789;
  return fromConfig || fromEnv || `http://127.0.0.1:${fallbackPort}/callback`;
}

function resolveSpotifyAppCredentials() {
  const clientId = normalizeSecretInput(process.env.SPOTIFY_CLIENT_ID);
  const clientSecret = normalizeSecretInput(process.env.SPOTIFY_CLIENT_SECRET);
  return { clientId, clientSecret };
}

function resolveSpotifyConnectionUserKey(sessionKey?: string): string {
  const value = sessionKey?.trim();
  if (!value) {
    return "default";
  }
  const parsed = parseAgentSessionKey(value);
  if (!parsed) {
    return value;
  }
  // Keep one Spotify link per agent instead of per ephemeral chat session key.
  return `agent:${parsed.agentId}`;
}

function resolveConnectionsPath(): string {
  return path.join(resolveOAuthDir(), SPOTIFY_CONNECTIONS_FILENAME);
}

function ensureConnectionsStore(): SpotifyConnectionsStore {
  const storePath = resolveConnectionsPath();
  const raw = loadJsonFile(storePath);
  if (raw && typeof raw === "object") {
    const usersRaw = (raw as { users?: unknown }).users;
    if (usersRaw && typeof usersRaw === "object") {
      return {
        version: 1,
        users: usersRaw as Record<string, SpotifyConnectionEntry>,
      };
    }
  }
  return { version: 1, users: {} };
}

function saveConnectionsStore(store: SpotifyConnectionsStore): void {
  const storePath = resolveConnectionsPath();
  const storeDir = path.dirname(storePath);
  fs.mkdirSync(storeDir, { recursive: true });
  saveJsonFile(storePath, store);
}

function resolveSpotifyTokenEncryptionSecret(cfg?: OpenClawConfig): string {
  const fromEnv = normalizeSecretInput(process.env.OPENCLAW_SPOTIFY_TOKEN_SECRET);
  if (fromEnv) {
    return fromEnv;
  }
  const fromGatewayToken = normalizeSecretInput(cfg?.gateway?.auth?.token);
  if (fromGatewayToken) {
    return fromGatewayToken;
  }
  const fromClientSecret = normalizeSecretInput(process.env.SPOTIFY_CLIENT_SECRET);
  if (fromClientSecret) {
    return fromClientSecret;
  }
  throw new ToolInputError(
    "No secure token secret available. Set OPENCLAW_SPOTIFY_TOKEN_SECRET or gateway.auth.token.",
  );
}

function encryptRefreshToken(token: string, secret: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, encrypted]).toString("base64");
}

function decryptRefreshToken(payload: string, secret: string): string {
  const raw = Buffer.from(payload, "base64");
  if (raw.length < 16 + 12 + 16 + 1) {
    throw new Error("Invalid encrypted token payload");
  }
  const salt = raw.subarray(0, 16);
  const iv = raw.subarray(16, 28);
  const tag = raw.subarray(28, 44);
  const ciphertext = raw.subarray(44);
  const key = crypto.scryptSync(secret, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

function buildSpotifyAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const qs = new URLSearchParams({
    client_id: params.clientId,
    response_type: "code",
    redirect_uri: params.redirectUri,
    scope: SPOTIFY_SCOPES.join(" "),
    state: params.state,
    show_dialog: "true",
  });
  return `https://accounts.spotify.com/authorize?${qs.toString()}`;
}

async function openUrl(url: string): Promise<boolean> {
  const platform = process.platform;
  const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const isSsh =
    Boolean(process.env.SSH_CLIENT) ||
    Boolean(process.env.SSH_TTY) ||
    Boolean(process.env.SSH_CONNECTION);

  let command: string[] | null = null;
  let verbatim = false;
  if (platform === "win32") {
    command = ["cmd", "/c", "start", "", `"${url}"`];
    verbatim = true;
  } else if (platform === "darwin") {
    command = ["open", url];
  } else if (platform === "linux" && !isSsh && hasDisplay) {
    command = ["xdg-open", url];
  }
  if (!command) {
    return false;
  }
  try {
    await runCommandWithTimeout(command, {
      timeoutMs: 5_000,
      windowsVerbatimArguments: verbatim,
    });
    return true;
  } catch {
    return false;
  }
}

function getExpectedRedirectPath(redirectUri: string): string {
  const u = new URL(redirectUri);
  return u.pathname || "/callback";
}

async function exchangeCodeForTokens(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ accessToken: string; refreshToken: string; scopes: string[] }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    error_description?: string;
    error?: string;
  };
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(payload.error_description || payload.error || "oauth_exchange_failed");
  }
  const scopes = payload.scope?.split(/\s+/).filter(Boolean) ?? [...SPOTIFY_SCOPES];
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    scopes,
  };
}

async function fetchSpotifyMe(accessToken: string): Promise<{ id: string }> {
  const response = await fetch("https://api.spotify.com/v1/me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
  if (!response.ok || !payload.id) {
    throw new Error(payload.error?.message || "spotify_me_failed");
  }
  return { id: payload.id };
}

async function refreshAccessToken(params: {
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || "spotify_refresh_failed");
  }
  return payload.access_token;
}

async function spotifyRequest<T>(
  pathName: string,
  accessToken: string,
  options?: { method?: "GET" | "POST" | "PUT"; body?: unknown },
): Promise<{ status: number; data: T | null }> {
  const method = options?.method ?? "GET";
  const response = await fetch(`https://api.spotify.com/v1${pathName}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(options?.body ? { "content-type": "application/json" } : {}),
    },
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  if (response.status === 204) {
    return { status: response.status, data: null };
  }
  const text = await response.text();
  const json = text ? (JSON.parse(text) as T | { error?: { message?: string } }) : null;
  if (!response.ok) {
    const errorMessage =
      json && typeof json === "object" && "error" in json
        ? ((json.error as { message?: string } | undefined)?.message ?? text)
        : text;
    throw new Error(errorMessage || `Spotify API error (${response.status})`);
  }
  return { status: response.status, data: (json as T) ?? null };
}

function resolvePlaybackBody(uri: string, autoPlayOnOpen: boolean) {
  if (uri.startsWith("spotify:track:")) {
    return { uris: [uri] as string[] };
  }
  if (
    uri.startsWith("spotify:album:") ||
    uri.startsWith("spotify:playlist:") ||
    uri.startsWith("spotify:artist:")
  ) {
    return autoPlayOnOpen ? { context_uri: uri } : { context_uri: uri, offset: { position: 0 } };
  }
  throw new ToolInputError("Unsupported Spotify URI. Use spotify:track|album|playlist|artist.");
}

function clearConnectionForUser(userKey: string): void {
  const store = ensureConnectionsStore();
  if (!store.users[userKey]) {
    return;
  }
  delete store.users[userKey];
  saveConnectionsStore(store);
}

async function ensureConnected(params: {
  cfg: OpenClawConfig;
  spotifyConfig: SpotifyConfig;
  userKey: string;
}): Promise<ConnectResult> {
  const { clientId, clientSecret } = resolveSpotifyAppCredentials();
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      code: "missing_app_credentials",
      message:
        "No tengo acceso a Spotify todavía. El administrador debe configurar SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET en el backend.",
    };
  }

  const secret = resolveSpotifyTokenEncryptionSecret(params.cfg);
  const store = ensureConnectionsStore();
  const existing = store.users[params.userKey];
  if (existing) {
    try {
      const refreshToken = decryptRefreshToken(existing.refreshTokenEncrypted, secret);
      await refreshAccessToken({ refreshToken, clientId, clientSecret });
      return { ok: true, refreshedFromStore: true };
    } catch (err) {
      const message = String(err).toLowerCase();
      if (message.includes("invalid_grant") || message.includes("revoked")) {
        clearConnectionForUser(params.userKey);
      }
    }
  }

  const redirectUri = resolveOAuthRedirectUri(params.spotifyConfig, params.cfg);
  const state = crypto.randomBytes(16).toString("hex");
  const authorizeUrl = buildSpotifyAuthorizeUrl({
    clientId,
    redirectUri,
    state,
  });
  const opened = await openUrl(authorizeUrl);
  if (!opened) {
    return {
      ok: false,
      code: "browser_open_failed",
      message:
        "No pude abrir el navegador automáticamente. Copia este enlace para conectar Spotify.",
      connectUrl: authorizeUrl,
    };
  }

  try {
    const callback = await waitForSpotifyOAuthCallback({
      expectedState: state,
      expectedPath: getExpectedRedirectPath(redirectUri),
      timeoutMs: 3 * 60 * 1000,
    });
    const tokens = await exchangeCodeForTokens({
      code: callback.code,
      clientId,
      clientSecret,
      redirectUri,
    });
    const me = await fetchSpotifyMe(tokens.accessToken);
    const encryptedRefresh = encryptRefreshToken(tokens.refreshToken, secret);
    const latest = ensureConnectionsStore();
    latest.users[params.userKey] = {
      spotifyUserId: me.id,
      refreshTokenEncrypted: encryptedRefresh,
      scopes: tokens.scopes,
      connectedAt: Date.now(),
    };
    saveConnectionsStore(latest);
    return { ok: true, refreshedFromStore: false };
  } catch (err) {
    const raw = String(err);
    if (raw.includes("oauth_callback_timeout")) {
      return {
        ok: false,
        code: "callback_timeout",
        message: "No pude completar la conexión. ¿Quieres que lo intentemos de nuevo?",
        connectUrl: authorizeUrl,
      };
    }
    return {
      ok: false,
      code: "oauth_failed",
      message: "No pude completar la conexión. ¿Quieres que lo intentemos de nuevo?",
      connectUrl: authorizeUrl,
    };
  }
}

async function getUserAccessTokenForPlayback(params: {
  cfg: OpenClawConfig;
  userKey: string;
}): Promise<string> {
  const { clientId, clientSecret } = resolveSpotifyAppCredentials();
  if (!clientId || !clientSecret) {
    throw new ToolInputError("Spotify app credentials missing in backend environment.");
  }
  const store = ensureConnectionsStore();
  const entry = store.users[params.userKey];
  if (!entry) {
    throw new ToolInputError("Spotify not connected for this user.");
  }
  const secret = resolveSpotifyTokenEncryptionSecret(params.cfg);
  const refreshToken = decryptRefreshToken(entry.refreshTokenEncrypted, secret);
  try {
    return await refreshAccessToken({ refreshToken, clientId, clientSecret });
  } catch (err) {
    const raw = String(err).toLowerCase();
    if (raw.includes("invalid_grant") || raw.includes("revoked")) {
      clearConnectionForUser(params.userKey);
      throw new ToolInputError(
        "Perdí acceso a tu Spotify. Te pido reconectar y seguimos.",
      );
    }
    throw err;
  }
}

async function searchTracks(params: {
  query: string;
  limit: number;
  market?: string;
}): Promise<SpotifyTrack[]> {
  const { clientId, clientSecret } = resolveSpotifyAppCredentials();
  if (!clientId || !clientSecret) {
    throw new ToolInputError("Spotify app credentials missing in backend environment.");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenPayload = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !tokenPayload.access_token) {
    throw new Error("Failed to get Spotify app token.");
  }
  const search = new URLSearchParams({
    q: params.query,
    type: "track",
    limit: String(params.limit),
  });
  const market = params.market?.trim();
  if (market) {
    search.set("market", market);
  }
  const result = await spotifyRequest<{
    tracks?: {
      items?: Array<{
        id?: string;
        name?: string;
        uri?: string;
        external_urls?: { spotify?: string };
        artists?: Array<{ name?: string }>;
        album?: { name?: string };
      }>;
    };
  }>(`/search?${search.toString()}`, tokenPayload.access_token);

  return (result.data?.tracks?.items ?? [])
    .map((item) => ({
      id: item.id ?? "",
      name: item.name ?? "",
      uri: item.uri ?? "",
      url: item.external_urls?.spotify ?? "",
      artists: (item.artists ?? []).map((artist) => artist.name ?? "").filter(Boolean),
      album: item.album?.name,
    }))
    .filter((track) => Boolean(track.id && track.uri && track.name));
}

export function createSpotifyTool(opts?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool {
  return {
    label: "Spotify",
    name: "spotify",
    description:
      "Control Spotify playback with one-time OAuth connect. On first play, opens Spotify login automatically and retries.",
    parameters: SpotifyToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", {
        required: true,
      }) as (typeof SPOTIFY_ACTIONS)[number];
      const cfg = opts?.config ?? loadConfig();
      const spotify = resolveSpotifyConfig(cfg);
      const enabled = spotify.enabled ?? true;
      if (!enabled) {
        return jsonResult({
          ok: false,
          error: "spotify_disabled",
          message: "Spotify está desactivado en la configuración.",
        });
      }

      const userKey = resolveSpotifyConnectionUserKey(opts?.agentSessionKey);

      if (action === "connect") {
        const connect = await ensureConnected({
          cfg,
          spotifyConfig: spotify,
          userKey,
        });
        if (!connect.ok) {
          return jsonResult({
            ok: false,
            action,
            requiresConnection: true,
            connectUrl: connect.connectUrl ?? null,
            message: connect.message,
          });
        }
        return jsonResult({
          ok: true,
          action,
          message: "Listo, Spotify conectado.",
          reused: connect.refreshedFromStore,
        });
      }

      if (action === "search") {
        const query = readStringParam(params, "query", {
          required: true,
          label: "query",
        });
        const limit = Math.max(1, Math.min(10, Math.trunc(readNumberParam(params, "limit") ?? 5)));
        const tracks = await searchTracks({
          query,
          limit,
          market: spotify.market,
        });
        return jsonResult({
          ok: true,
          action,
          count: tracks.length,
          tracks,
        });
      }

      const connect = await ensureConnected({
        cfg,
        spotifyConfig: spotify,
        userKey,
      });
      if (!connect.ok) {
        return jsonResult({
          ok: false,
          action,
          requiresConnection: true,
          connectUrl: connect.connectUrl ?? null,
          message:
            connect.code === "browser_open_failed"
              ? `${connect.message}${connect.connectUrl ? ` ${connect.connectUrl}` : ""}`
              : "Para reproducir en Spotify necesito conectarte una vez. Te abro acceso ahora.",
        });
      }

      const accessToken = await getUserAccessTokenForPlayback({
        cfg,
        userKey,
      });

      if (action === "play") {
        let uri = readStringParam(params, "uri");
        const queryText = readStringParam(params, "query");
        if (!uri) {
          if (!queryText) {
            throw new ToolInputError("play requires uri or query");
          }
          const tracks = await searchTracks({
            query: queryText,
            limit: 1,
            market: spotify.market,
          });
          const first = tracks[0];
          if (!first) {
            return jsonResult({
              ok: false,
              action,
              error: "not_found",
              message: "No encontré esa canción en Spotify.",
            });
          }
          uri = first.uri;
        }
        const deviceId =
          readStringParam(params, "deviceId") || spotify.defaultDeviceId?.trim() || undefined;
        const autoPlayOnOpen = spotify.autoPlayOnOpen ?? true;
        const body = resolvePlaybackBody(uri, autoPlayOnOpen);
        const playbackQuery = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
        await spotifyRequest(`/me/player/play${playbackQuery}`, accessToken, {
          method: "PUT",
          body,
        });
        return jsonResult({
          ok: true,
          action,
          uri,
          deviceId: deviceId ?? null,
          message: connect.refreshedFromStore
            ? "Reproduciendo."
            : "Listo, Spotify conectado. Reproduciendo.",
        });
      }

      if (action === "pause") {
        const deviceId =
          readStringParam(params, "deviceId") || spotify.defaultDeviceId?.trim() || undefined;
        const playbackQuery = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
        await spotifyRequest(`/me/player/pause${playbackQuery}`, accessToken, {
          method: "PUT",
        });
        return jsonResult({
          ok: true,
          action,
          deviceId: deviceId ?? null,
        });
      }

      if (action === "next" || action === "previous") {
        const endpoint = action === "next" ? "/me/player/next" : "/me/player/previous";
        const deviceId =
          readStringParam(params, "deviceId") || spotify.defaultDeviceId?.trim() || undefined;
        const playbackQuery = deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : "";
        await spotifyRequest(`${endpoint}${playbackQuery}`, accessToken, {
          method: "POST",
        });
        return jsonResult({
          ok: true,
          action,
          deviceId: deviceId ?? null,
        });
      }

      if (action === "devices") {
        const result = await spotifyRequest<{
          devices?: Array<{
            id?: string;
            is_active?: boolean;
            is_restricted?: boolean;
            name?: string;
            type?: string;
            volume_percent?: number;
          }>;
        }>("/me/player/devices", accessToken);
        return jsonResult({
          ok: true,
          action,
          devices: result.data?.devices ?? [],
        });
      }

      if (action === "status") {
        const result = await spotifyRequest<Record<string, unknown>>(
          "/me/player/currently-playing",
          accessToken,
        );
        return jsonResult({
          ok: true,
          action,
          active: result.status !== 204,
          playback: result.data,
        });
      }

      throw new ToolInputError(`Unsupported action: ${action}`);
    },
  };
}



