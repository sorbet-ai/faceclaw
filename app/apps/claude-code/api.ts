// even-cc's HTTP API (sessions, history, prompts, permission and question
// answers) and its live events over the /api/ws WebSocket. See even-cc's
// docs/even-protocol.md.

import { openSocket, type SocketConnection } from "../../native/socket";
import { fetchTextWithUserAgent } from "../../util/http";
import type { HistoryItem } from "./core/model";

export interface ServerConfig {
  base: string; // http://192.168.1.85:3456
  token: string;
}

export interface SessionInfo {
  id: string;
  title: string;
  timestamp: string;
  cwd: string;
  status: string | null;
}

async function call<T>(cfg: ServerConfig, path: string, body?: unknown): Promise<T> {
  if (!cfg.base) throw new Error("No PC for this session: scan the QR code even-cc prints (menu > Settings > PCs).");
  const r = await fetchTextWithUserAgent(cfg.base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + cfg.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 15000,
  });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json<T>();
}

export const listSessions = (cfg: ServerConfig) =>
  call<{ sessions: SessionInfo[] }>(cfg, "/api/sessions?provider=claude").then((r) => r.sessions);

export const history = (cfg: ServerConfig, id: string) =>
  call<{ history: HistoryItem[] }>(cfg, `/api/sessions/${encodeURIComponent(id)}/history?limit=200&provider=claude`).then((r) => r.history);

export type PermissionDecision = "allow" | "allowAlways" | "deny";

export const answerPermission = (cfg: ServerConfig, sessionId: string, decision: PermissionDecision) =>
  call(cfg, "/api/permission-response", { sessionId, decision });

export const answerQuestion = (cfg: ServerConfig, sessionId: string, answer: string) =>
  call(cfg, "/api/question-response", { sessionId, answer });

/** sessionId "" starts a new session; the reply names it. */
export const sendPrompt = (cfg: ServerConfig, sessionId: string, text: string) =>
  call<{ sessionId: string }>(cfg, "/api/prompt", { sessionId, text, provider: "claude" });

export const interrupt = (cfg: ServerConfig, sessionId: string) =>
  call(cfg, "/api/interrupt", { sessionId, provider: "claude" });

export type ServerEvent = { type: string; [k: string]: any };

/** Follows a session's live events, reconnecting after drops. Returns stop. */
export function follow(cfg: ServerConfig, sessionId: string, onEvent: (ev: ServerEvent) => void,
  onState: (connected: boolean, why?: string) => void): () => void {
  let socket: SocketConnection | null = null;
  let closed = false;
  let generation = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    const mine = ++generation;
    const q = `token=${encodeURIComponent(cfg.token)}&sessionId=${encodeURIComponent(sessionId)}`;
    const lost = (why: string) => {
      if (closed || mine !== generation) return;
      onState(false, why);
      retry = setTimeout(open, 2000);
    };
    try {
      socket = openSocket(cfg.base.replace(/^http/, "ws") + "/api/ws?" + q, {
        onOpen: () => { if (!closed && mine === generation) onState(true); },
        onTextMessage: (message: string) => {
          if (closed || mine !== generation) return;
          let ev: ServerEvent;
          try {
            ev = JSON.parse(String(message));
          } catch (e) {
            console.error(`claude-code: bad event ${String(message).slice(0, 200)}: ${e}`);
            return;
          }
          onEvent(ev);
        },
        onClosed: (code: number, reason: string) => lost(reason || `closed ${code}`),
        onFailure: (message: string) => lost(String(message)),
      });
    } catch (e) {
      lost(String(e));
    }
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.close(1000, "");
  };
}
