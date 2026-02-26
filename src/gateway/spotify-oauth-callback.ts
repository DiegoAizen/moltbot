import type { IncomingMessage, ServerResponse } from "node:http";

type PendingSpotifyOAuth = {
  expectedPath: string;
  resolve: (value: { code: string }) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

const pendingByState = new Map<string, PendingSpotifyOAuth>();

function renderHtml(title: string, message: string): string {
  return [
    "<!doctype html>",
    "<html><head><meta charset='utf-8' /></head>",
    `<body><h2>${title}</h2><p>${message}</p></body></html>`,
  ].join("");
}

function clearPending(state: string): void {
  const pending = pendingByState.get(state);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingByState.delete(state);
}

export async function waitForSpotifyOAuthCallback(params: {
  expectedState: string;
  expectedPath: string;
  timeoutMs: number;
}): Promise<{ code: string }> {
  const state = params.expectedState.trim();
  if (!state) {
    throw new Error("spotify_oauth_state_missing");
  }
  if (pendingByState.has(state)) {
    throw new Error("spotify_oauth_state_conflict");
  }
  const expectedPath = params.expectedPath || "/callback";
  return await new Promise<{ code: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingByState.delete(state);
      reject(new Error("oauth_callback_timeout"));
    }, params.timeoutMs);

    pendingByState.set(state, {
      expectedPath,
      resolve,
      reject,
      timer,
    });
  });
}

export function handleSpotifyOAuthCallbackHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const host = req.headers.host ?? "127.0.0.1";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const state = url.searchParams.get("state")?.trim() ?? "";
  if (!state) {
    return false;
  }

  const pending = pendingByState.get(state);
  if (!pending) {
    return false;
  }

  if (url.pathname !== pending.expectedPath) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(
      renderHtml(
        "Spotify callback inválido",
        "La ruta de callback no coincide con la esperada. Vuelve a intentar la conexión.",
      ),
    );
    return true;
  }

  const code = url.searchParams.get("code")?.trim();
  if (!code) {
    clearPending(state);
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(renderHtml("Spotify callback inválido", "Falta el parámetro code."));
    pending.reject(new Error("oauth_callback_missing_code"));
    return true;
  }

  clearPending(state);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(
    renderHtml(
      "Spotify conectado",
      "Listo. Puedes cerrar esta ventana y volver a OpenClaw.",
    ),
  );
  pending.resolve({ code });
  return true;
}
