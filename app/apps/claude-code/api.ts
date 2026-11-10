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
  /** The client holding the session elsewhere (VS Code, a terminal); read only here. */
  openElsewhere?: string;
}

/** A failed even-cc call; status is the HTTP status (0 = no answer). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly detail: string) {
    super(message);
  }
}

async function call<T>(cfg: ServerConfig, path: string, body?: unknown): Promise<T> {
  if (!cfg.base) throw new Error("No PC for this session: scan the QR code even-cc prints (menu > Settings > PCs).");
  const r = await fetchTextWithUserAgent(cfg.base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + cfg.token, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs: 15000,
  });
  if (!r.ok) {
    const text = (await r.text()).slice(0, 200);
    let detail = text;
    try {
      detail = JSON.parse(text).error ?? text;
    } catch {}
    throw new ApiError(`${path}: HTTP ${r.status} ${text}`, r.status, detail);
  }
  return r.json<T>();
}

export const listSessions = (cfg: ServerConfig) =>
  call<{ sessions: SessionInfo[] }>(cfg, "/api/sessions?provider=claude").then((r) => r.sessions);

/** The transcript, and who else holds the session (open elsewhere = read only). */
export const history = (cfg: ServerConfig, id: string) =>
  call<{ history: HistoryItem[]; openElsewhere?: string; elsewhereBusy?: boolean }>(cfg, `/api/sessions/${encodeURIComponent(id)}/history?limit=200&provider=claude`);

export interface UsageWindow {
  utilization: number; // 0..1
  resetsAt: number; // unix seconds
  status?: string;
}

/** Who a machine runs Claude as, and its plan usage (as of its last turn). */
export interface MachineInfo {
  name: string;
  account: { email?: string; organization?: string; subscriptionType?: string };
  usage: { windows: Record<string, UsageWindow>; isUsingOverage?: boolean; at: string } | null;
  version?: string;
}

export const machineInfo = (cfg: ServerConfig) => call<MachineInfo>(cfg, "/api/machine");

export type PermissionDecision = "allow" | "allowAlways" | "deny";

export const answerPermission = (cfg: ServerConfig, sessionId: string, decision: PermissionDecision) =>
  call(cfg, "/api/permission-response", { sessionId, decision });

export const answerQuestion = (cfg: ServerConfig, sessionId: string, answer: string) =>
  call(cfg, "/api/question-response", { sessionId, answer });

/**
 * sessionId "" starts a new session; the reply names it. fork: carry the
 * session on in a new one (for a session open elsewhere, which refuses
 * prompts with 409).
 */
export const sendPrompt = (cfg: ServerConfig, sessionId: string, text: string, fork = false) =>
  call<{ sessionId: string }>(cfg, "/api/prompt", { sessionId, text, provider: "claude", ...(fork ? { fork: true } : {}) });

/**
 * Closes the Claude Code process holding a session elsewhere (VS Code, a
 * terminal) so this app continues it. Without force, a holder that looks
 * mid-turn answers 409.
 */
export const release = (cfg: ServerConfig, sessionId: string, force: boolean) =>
  call(cfg, "/api/release", { sessionId, force });

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
