import type { GatewayRequestHandlers } from "./types.js";
import { createSpotifyTool } from "../../agents/tools/spotify-tool.js";
import { loadConfig } from "../../config/config.js";
import { formatForLog } from "../ws-log.js";

type SpotifyConnectDetails = {
  ok?: boolean;
  message?: string;
  requiresConnection?: boolean;
  connectUrl?: string | null;
};

export const spotifyHandlers: GatewayRequestHandlers = {
  "spotify.connect": async ({ params, respond }) => {
    try {
      const cfg = loadConfig();
      const sessionKey =
        typeof params.sessionKey === "string" && params.sessionKey.trim()
          ? params.sessionKey.trim()
          : undefined;
      const tool = createSpotifyTool({ config: cfg, agentSessionKey: sessionKey });
      const result = await tool.execute(`gateway-spotify-connect-${Date.now()}`, {
        action: "connect",
      });
      const details = (result?.details ?? null) as SpotifyConnectDetails | null;
      if (!details) {
        respond(true, { ok: true, message: "Listo, Spotify conectado." });
        return;
      }
      respond(true, details);
    } catch (err) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: formatForLog(err),
      });
    }
  },
};
