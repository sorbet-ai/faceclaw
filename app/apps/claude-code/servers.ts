// The even-cc servers the Claude Code app knows (Windows, WSL, other PCs),
// added by scanning even-cc's setup QR code: the phone camera opens even-cc's
// setup page, which opens an evencc://add link in this app.

import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { loadConnections, saveConnections } from "../terminal/connections";
import { voiceProviderSetting, whisperServerApiKeySetting, whisperServerUrlSetting } from "../../ui/dashboard-settings";

export interface EvenCcServer {
  name: string;
  url: string; // http://192.168.1.85:3456
  token: string;
}

const SERVERS_KEY = "claudeCode.servers";
// first-version settings, before the list
const LEGACY_URL_KEY = "claudeCode.server";
const LEGACY_TOKEN_KEY = "claudeCode.token";

export function loadServers(): EvenCcServer[] {
  const raw = getStringSetting(SERVERS_KEY, "");
  if (raw) {
    try {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        return list
          .map((s: any) => ({ name: String(s?.name ?? ""), url: String(s?.url ?? "").replace(/\/+$/, ""), token: String(s?.token ?? "") }))
          .filter((s) => s.url && s.token);
      }
    } catch (e) {
      console.error(`claude-code: unreadable server list: ${e}`);
    }
    return [];
  }
  const url = getStringSetting(LEGACY_URL_KEY, "").trim().replace(/\/+$/, "");
  const token = getStringSetting(LEGACY_TOKEN_KEY, "").trim();
  return url && token ? [{ name: hostOf(url), url, token }] : [];
}

export function saveServers(list: EvenCcServer[]): void {
  setStringSetting(SERVERS_KEY, JSON.stringify(list));
}

export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[:/].*$/, "");
}

/** Adds or updates (same address) a server; returns it. */
export function addServer(server: EvenCcServer): EvenCcServer {
  const list = loadServers().filter((s) => s.url !== server.url);
  list.push(server);
  saveServers(list);
  return server;
}

export function removeServer(url: string): void {
  saveServers(loadServers().filter((s) => s.url !== url));
}

export interface AddResult {
  server: EvenCcServer;
  speech: boolean;
  terminal: boolean;
}

/**
 * Handles even-cc's QR code (http://<pc>:<port>/setup?token=&name=[&stt=1]
 * [&terminal=g2mirror://...], scanned in Faceclaw) and the evencc://add?url=&...
 * link its setup page opens: adds the server, points voice at its Whisper
 * proxy when it has one, and adds its terminal mirror to the Terminal app.
 */
export function addFromLink(link: string): AddResult | null {
  const text = link.trim();
  const add = /^evencc:\/\/add\?(.*)$/i.exec(text);
  const setup = /^(https?:\/\/[^/?#]+)\/setup\?(.*)$/i.exec(text);
  if (!add && !setup) return null;
  const q = new Map<string, string>();
  for (const part of (add ? add[1] : setup![2]).split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    q.set(decodeURIComponent(part.slice(0, i).replace(/\+/g, " ")), decodeURIComponent(part.slice(i + 1).replace(/\+/g, " ")));
  }
  if (setup) q.set("url", setup[1]);
  const url = (q.get("url") ?? "").trim().replace(/\/+$/, "");
  const token = (q.get("token") ?? "").trim();
  if (!/^https?:\/\/[^/]+$/i.test(url) || !token) return null;
  const server = addServer({ name: (q.get("name") ?? "").trim() || hostOf(url), url, token });

  const speech = q.get("stt") === "1";
  if (speech) {
    whisperServerUrlSetting.set(`${url}/api/stt/v1`);
    whisperServerApiKeySetting.set(token);
    voiceProviderSetting.set("whisper-server");
  }
  const mirror = (q.get("terminal") ?? "").trim();
  let terminal = false;
  if (/^g2mirrors?:\/\//.test(mirror)) {
    const host = mirror.replace(/^g2mirrors?:\/\/[^@]*@/, "");
    const connections = loadConnections().filter((c) => c.url.replace(/^g2mirrors?:\/\/[^@]*@/, "") !== host);
    connections.push({ id: `evencc-${Date.now().toString(36)}`, url: mirror, serverName: server.name, enabled: true });
    saveConnections(connections);
    terminal = true;
  }
  return { server, speech, terminal };
}
