// Claude Code on the glasses, through even-cc: a session laid out like the
// Claude Code TUI (prompts on a shaded band, ⏺ replies, ⏺ Tool(args) with ⎿
// output, an input box and a status line), on the whole panel.
//
// Gestures (hold-to-talk window): hold to talk and watch the words, release
// for a draft (tap sends, double tap drops); slide scrolls; tap opens the
// menu (sessions, new session, interrupt, settings); double tap leaves.
// Permission prompts and questions float over the conversation: slide moves
// the highlight, tap picks, double tap hides it (the menu reopens it); a
// question can also be answered by holding to talk.

import { GrayImage, type UiFont } from "../../graphics/image";
import { getTerminusFont } from "../../graphics/bdffont";
import { getDefaultSmallFont } from "../../graphics/ui-fonts";
import { truncateText, wrapText } from "../../graphics/textwrap";
import { getStringSetting, setStringSetting } from "../../native/settings-store";
import { asrModelState, isAsrModelReady, onAsrModelStateChanged, startAsrModelDownload, type AsrModelId } from "../../native/asr-model";
import { voiceProviderSetting } from "../../ui/dashboard-settings";
import type { InputEvent } from "../../ui/gestures";
import type { Layer, LayerContext, LayerStack, PaintBelow } from "../../ui/layers";
import { MenuLayer, type MenuItem } from "../../ui/menu";
import { WINDOW_MENU_LAYOUT } from "../../ui/window-menu";
import { GESTURE_SHORT_THEN_LONG_PRESS, gestureHints } from "../../ui/gestures";
import { createInProcessWindow, type InProcessAppOptions, type InProcessWindow } from "../../ui/shell/in-process-window";
import { shell } from "../../ui/shell/shell";
import { VoiceDraft } from "../ai-chat/voice-draft";
import * as api from "./api";
import { addFromLink, loadServers, removeServer, type EvenCcServer } from "./servers";
import { isQrScannerAvailable, scanQrCode } from "../../native/qr-scan";
import { apply, emptyConversation, fromHistory, statusLeft, type Conversation } from "./core/model";
import { layout, type Line, type Style } from "./core/layout";

export const APP_ID = "claude-code";

/**
 * Menus drawn in the window's own plane. A nearer stereo depth (Faceclaw's
 * menus use 4) goes to the glasses as a cached image, and in this full-panel
 * window those stopped updating after the first change.
 */
export function flatMenu(title: string, items: MenuItem[], width = WINDOW_MENU_LAYOUT.width): MenuLayer {
  return new MenuLayer(title, items, { ...WINDOW_MENU_LAYOUT, depth: 0, width,
    footer: gestureHints([[GESTURE_SHORT_THEN_LONG_PRESS, "system menu"]]) });
}

/** Session lists use nearly the whole window, and labels are cut to fit. */
const WIDE_MENU = 540;
function fitLabel(text: string): string {
  return truncateText(getDefaultSmallFont(), text, WIDE_MENU - 48);
}


const FONT_SIZES = [12, 14, 16, 18, 20];
const FONT_KEY = "claudeCode.fontSize";
const TOOL_OUTPUT_KEY = "claudeCode.toolOutput";
const SCROLL_KEY = "claudeCode.scroll"; // "natural" | "reversed"

type Session = api.SessionInfo & { server: EvenCcServer };
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽"];
const SCROLL_LINES = 3;

/** Gray levels per layout style. */
const SHADE: Record<Style, number> = {
  text: 205, bold: 255, code: 225, dim: 130, faint: 90, heading: 255, link: 215,
  prompt: 215, promptMark: 255, bullet: 255, tool: 255, toolArg: 150, toolRunning: 120, err: 255,
  rule: 70, meta: 130, ask: 255, option: 205,
};
const BOLD_STYLES = new Set<Style>(["bold", "heading", "tool", "ask", "promptMark", "err"]);
const BAND = 38;

/** Characters drawn as shapes when the font lacks them. */
const ASCII_SUBS: Record<string, string> = {
  "✔": "v", "✓": "v", "✖": "x", "✗": "x", "→": "->", "←": "<-", "…": "...", "›": ">", "•": "*",
  "●": "*", "○": "o", "✻": "*", "✶": "*", "✳": "*", "✢": "+", "✽": "*", "⏵": ">", "“": "\"", "”": "\"", "‘": "'", "’": "'",
};

class Grid {
  readonly font: UiFont;
  readonly bold: UiFont;
  readonly cellW: number;
  readonly pitch: number;
  constructor(size: number) {
    this.font = getTerminusFont(size, false) ?? getTerminusFont(12, false)!;
    this.bold = getTerminusFont(size, true) ?? this.font;
    this.cellW = Math.max(1, Math.round(this.font.measureText("0")));
    this.pitch = this.font.lineHeight;
  }

  /** Draws one row of styled spans on the cell grid, symbols as shapes when needed. */
  drawSpans(image: GrayImage, x0: number, y: number, spans: { text: string; style: Style }[], maxCols: number, shade?: number) {
    let col = 0;
    for (const sp of spans) {
      const value = shade ?? SHADE[sp.style];
      const font = BOLD_STYLES.has(sp.style) ? this.bold : this.font;
      let run = "";
      let runCol = col;
      const flush = () => {
        if (run.trim()) font.drawText(image, x0 + runCol * this.cellW, y, run, value);
        run = "";
      };
      for (const ch of sp.text) {
        if (col >= maxCols) break;
        const cp = ch.codePointAt(0)!;
        if (cp < 128 || font.hasGlyph(cp)) {
          if (!run) runCol = col;
          run += ch;
        } else {
          flush();
          this.drawSymbol(image, x0 + col * this.cellW, y, ch, value, font);
        }
        col++;
      }
      flush();
    }
  }

  drawSymbol(image: GrayImage, x: number, y: number, ch: string, value: number, font: UiFont) {
    const w = this.cellW, h = this.pitch;
    const cx = x + Math.floor(w / 2), cy = y + Math.floor(h / 2);
    switch (ch) {
      case "⏺": {
        const r = Math.max(2, Math.round(Math.min(w, h) * 0.3));
        for (let dy = -r; dy <= r; dy++) {
          const dx = Math.floor(Math.sqrt(r * r - dy * dy));
          image.fillRect(cx - dx, cy + dy, 2 * dx + 1, 1, value);
        }
        return;
      }
      case "⎿":
        image.fillRect(cx - 1, y, 1, Math.floor(h / 2), value);
        image.fillRect(cx - 1, cy, x + w - cx + 1, 1, value);
        return;
      case "❯": case "⏵": {
        const s = Math.max(2, Math.floor(Math.min(w, h) / 3));
        image.drawLine(cx - s, cy - s, cx + s - 1, cy, value);
        image.drawLine(cx - s, cy + s, cx + s - 1, cy, value);
        return;
      }
      case "▌": case "┃": case "▐":
        image.fillRect(cx - 1, y, 2, h, value);
        return;
    }
    const sub = ASCII_SUBS[ch] ?? (ch.normalize("NFD").replace(/[̀-ͯ]/g, "") || "?");
    font.drawText(image, x, y, /^[\x20-\x7e]$/.test(sub[0] ?? "") ? sub[0] : "?", value);
  }
}

export class ClaudeCodeApp implements Layer {
  conv: Conversation = emptyConversation();
  lines: Line[] = [];
  first = 0;
  follow = true;
  connected = false;
  sessionId = "";
  title = "";
  sessions: Session[] = [];
  /** The PC the open session lives on. */
  server: EvenCcServer | null = null;
  /** PCs that didn't answer the last session refresh. */
  offline: string[] = [];
  note = "";
  grid: Grid;
  cols = 80;
  rows = 30;
  window!: InProcessWindow;
  readonly draft: VoiceDraft;
  private stopFollow: () => void = () => {};
  private spin = 0;
  private spinTimer: ReturnType<typeof setInterval> | undefined;
  private noteTimer: ReturnType<typeof setTimeout> | undefined;
  private prompt: PromptLayer | null = null;
  private dismissed = ""; // the prompt the wearer hid with double tap
  private laidOutFor = "";

  constructor(private readonly options: InProcessAppOptions) {
    this.grid = new Grid(this.fontSize());
    this.draft = new VoiceDraft(options.actions, () => shell.prepareChatVoiceCapture(APP_ID),
      () => this.render(), (text) => this.voiceDone(text));
  }

  get cfg(): api.ServerConfig {
    return { base: this.server?.url ?? "", token: this.server?.token ?? "" };
  }

  reversedScroll(): boolean {
    return getStringSetting(SCROLL_KEY, "natural") === "reversed";
  }

  fontSize(): number {
    const n = Number(getStringSetting(FONT_KEY, "14"));
    return FONT_SIZES.includes(n) ? n : 14;
  }

  toolOutput(): boolean {
    return getStringSetting(TOOL_OUTPUT_KEY, "on") !== "off";
  }

  render() {
    this.window?.requestRender();
  }

  /** The on-device speech model the voice setting needs, if any. */
  speechModel(): AsrModelId | null {
    const provider = voiceProviderSetting.get();
    if (provider === "onboard") return "moonshine";
    if (provider === "onboard-whisper") return "whisper-base-en";
    return null;
  }

  /** Fetches a missing on-device speech model (a reinstall deletes it), showing progress. */
  ensureSpeechModel(): boolean {
    const id = this.speechModel();
    if (!id || isAsrModelReady(id)) return true;
    if (asrModelState(id).status !== "downloading") {
      startAsrModelDownload(id);
      this.stopModelWatch();
      this.stopModelWatch = onAsrModelStateChanged(id, (st) => {
        const pct = st.totalBytes > 0 ? Math.floor((st.bytesDownloaded / st.totalBytes) * 100) : 0;
        this.voiceNote = st.status === "downloading" ? `downloading the speech model ${pct}%` :
          st.status === "ready" ? "speech model ready: hold to talk" : `speech model: ${st.status}`;
        this.render();
      });
    }
    this.voiceNote ||= "downloading the speech model...";
    this.render();
    return false;
  }
  private stopModelWatch: () => void = () => {};
  voiceNote = "";

  start() {
    this.ensureSpeechModel();
    this.spinTimer = setInterval(() => {
      if (this.busy()) {
        this.spin++;
        this.render();
      }
    }, 1000); // each redraw competes with ring input for the Bluetooth link
    void this.showSessions(true);
  }

  /**
   * The session list: per PC, "+ New session" first, then its sessions newest first.
   * It is the app's opening screen; the menu's Sessions shows it again.
   */
  async showSessions(opening = false) {
    if (opening) {
      this.conv = emptyConversation();
      this.conv.blocks.push({ kind: "meta", text: "Loading your sessions..." });
      this.laidOutFor = "";
      this.render();
    }
    if (!loadServers().length) {
      this.conv = emptyConversation();
      this.conv.blocks.push({ kind: "meta", text: "No machines yet. Run even-cc, then Settings > Machines > Add machine." });
      this.laidOutFor = "";
      this.render();
      return;
    }
    await this.refreshSessions();
    if (opening) {
      this.conv = emptyConversation();
      this.conv.blocks.push({ kind: "meta", text: "Tap for the menu." });
      this.laidOutFor = "";
    }
    this.window.stack.clearToBase();
    this.window.stack.push(this.sessionMenu());
    this.render();
  }

  stop() {
    this.stopFollow();
    this.stopModelWatch();
    this.draft.cancel();
    clearInterval(this.spinTimer);
    clearTimeout(this.noteTimer);
  }

  busy(): boolean {
    return this.conv.activity !== "idle" && this.conv.activity !== "waiting";
  }

  // ── session ─────────────────────────────────────────────

  /** Sessions from every PC, newest first; PCs that don't answer go to offline. */
  async refreshSessions(): Promise<Session[]> {
    const servers = loadServers();
    const results = await Promise.allSettled(servers.map((server) =>
      api.listSessions({ base: server.url, token: server.token }).then((list) => list.map((s) => ({ ...s, server })))));
    const all: Session[] = [];
    this.offline = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") all.push(...r.value);
      else {
        this.offline.push(servers[i].name);
        console.warn(`claude-code: ${servers[i].name} unreachable: ${r.reason}`);
      }
    });
    all.sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
    this.sessions = all;
    return all;
  }

  async open(sessionId?: string, server?: EvenCcServer) {
    this.stopFollow();
    this.closePrompt();
    if (!sessionId) {
      const list = await this.refreshSessions();
      if (!list.length) {
        this.newSession(server ?? loadServers()[0] ?? null);
        return;
      }
      sessionId = list[0].id;
      server = list[0].server;
    }
    this.server = server ?? this.sessions.find((s) => s.id === sessionId)?.server ?? this.server;
    this.sessionId = sessionId;
    this.title = this.sessions.find((s) => s.id === sessionId)?.title ?? "";
    this.conv = fromHistory(await api.history(this.cfg, sessionId));
    this.follow = true;
    this.fillOnLayout = true;
    this.laidOutFor = "";
    this.render();
    const sid = sessionId;
    this.stopFollow = api.follow(this.cfg, sessionId, (ev) => {
      if (sid !== this.sessionId) return;
      if (apply(this.conv, ev)) {
        this.laidOutFor = "";
        this.syncPrompt();
        this.render();
      }
    }, (up, why) => {
      this.connected = up;
      if (!up) console.warn(`claude-code: disconnected: ${why ?? ""}`);
      this.render();
    });
  }

  newSession(server: EvenCcServer | null) {
    this.stopFollow();
    this.closePrompt();
    this.server = server;
    this.sessionId = "";
    this.title = "new session";
    this.conv = emptyConversation();
    this.conv.blocks.push({ kind: "meta", text: "New session. Hold to talk." });
    this.connected = true;
    this.laidOutFor = "";
    this.render();
  }

  fail(e: unknown) {
    const text = String(e instanceof Error ? e.message : e);
    console.error(`claude-code: ${text}`);
    this.conv.blocks.push({ kind: "error", text });
    this.laidOutFor = "";
    this.render();
  }

  flash(msg: string) {
    this.note = msg;
    this.render();
    clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => {
      this.note = "";
      this.render();
    }, 3000);
  }

  // ── prompts ─────────────────────────────────────────────

  /** The pending permission or question block, if any. */
  pendingBlock() {
    if (!this.conv.pendingPermission && !this.conv.pendingQuestion) return null;
    for (let i = this.conv.blocks.length - 1; i >= 0; i--) {
      const b = this.conv.blocks[i];
      if ((this.conv.pendingPermission && b.kind === "permission") || (this.conv.pendingQuestion && b.kind === "question")) return { block: b, index: i };
    }
    return null;
  }

  /** Floats the pending prompt over the conversation, or removes a resolved one. */
  syncPrompt(force = false) {
    const p = this.pendingBlock();
    const key = p ? `${this.sessionId}:${p.index}` : "";
    if (!p) {
      this.closePrompt();
      return;
    }
    if (this.prompt?.key === key) return;
    if (!force && this.dismissed === key) return;
    this.closePrompt();
    const b = p.block;
    const sid = this.sessionId;
    const cfg = this.cfg;
    let layer: PromptLayer;
    if (b.kind === "permission") {
      layer = new PromptLayer(this, key, `Claude wants to use ${b.tool}`, [b.description, b.detail].filter(Boolean).join("\n"), [
        { label: "Yes", act: () => api.answerPermission(cfg, sid, "allow") },
        { label: "Yes, and don't ask again", act: () => api.answerPermission(cfg, sid, "allowAlways") },
        { label: "No", act: () => api.answerPermission(cfg, sid, "deny") },
      ], false);
    } else if (b.kind === "question") {
      layer = new PromptLayer(this, key, "Claude asks", b.question,
        b.options.map((o) => ({ label: o, act: () => api.answerQuestion(cfg, sid, o) })), true);
    } else return;
    this.prompt = layer;
    this.window.stack.push(layer);
    this.render();
  }

  closePrompt() {
    const layer = this.prompt;
    if (!layer) return;
    this.prompt = null;
    removeLayer(this.window?.stack, layer);
  }

  async answer(layer: PromptLayer, choice: { label: string; act: () => Promise<unknown> }) {
    this.closePrompt();
    this.render();
    try {
      await choice.act();
      this.flash(choice.label);
    } catch (e) {
      this.fail(e);
    }
  }

  dismissPrompt(layer: PromptLayer) {
    this.dismissed = layer.key;
    this.closePrompt();
    this.flash("hidden · menu > Answer prompt");
  }

  // ── voice ───────────────────────────────────────────────

  startTalking() {
    if (this.draft.active) return;
    if (!this.ensureSpeechModel()) return;
    this.voiceNote = "";
    void this.draft.start();
  }

  releaseTalking() {
    this.draft.release();
  }

  /** A finished utterance: answer the open question, or confirm it as a prompt. */
  private voiceDone(text: string) {
    if (this.prompt?.acceptsText) {
      const sid = this.sessionId;
      const cfg = this.cfg;
      void this.answer(this.prompt, { label: "answered", act: () => api.answerQuestion(cfg, sid, text) });
      return;
    }
    const layer = new DraftLayer(this, text);
    this.window.stack.push(layer);
    layer.start(this.window.stack);
    this.render();
  }

  async sendPrompt(text: string) {
    this.follow = true;
    const fresh = !this.sessionId;
    if (fresh) this.conv.blocks.push({ kind: "prompt", text });
    this.laidOutFor = "";
    this.render();
    try {
      const r = await api.sendPrompt(this.cfg, this.sessionId, text);
      if (r?.sessionId && r.sessionId !== this.sessionId) {
        await this.refreshSessions().catch(() => []);
        await this.open(r.sessionId);
      }
    } catch (e) {
      this.fail(e);
    }
  }

  // ── layout and paint ────────────────────────────────────

  private bottomRows(): number {
    return 4; // rule, input, rule, status
  }

  /** Height of the input box and status line at the bottom, for overlays to sit above. */
  inputTop(): number {
    return this.bottomRows() * this.grid.pitch + 2;
  }

  private ensureLayout(width: number, height: number) {
    const size = this.fontSize();
    if (this.grid.font !== (getTerminusFont(size, false) ?? this.grid.font)) this.grid = new Grid(size);
    const g = this.grid;
    const cols = Math.max(20, Math.floor((width - 8) / g.cellW));
    const rows = Math.max(3, Math.floor((height - 4) / g.pitch) - this.bottomRows());
    const key = `${cols}x${rows}:${this.toolOutput()}`;
    if (key === this.laidOutFor) return;
    this.cols = cols;
    this.rows = rows;
    this.lines = layout(this.conv.blocks, { cols, toolOutputLines: this.toolOutput() ? 3 : 0 });
    this.laidOutFor = key;
    if (this.fillOnLayout) {
      this.fillOnLayout = false;
      this.first = this.bottom(); // a full screen on opening and on "go to latest"
    } else {
      this.first = this.follow ? this.followFirst(this.first) : Math.min(this.first, Math.max(this.bottom(), this.first));
    }
  }

  /**
   * Following the live end, the view moves in steps: when new lines run past
   * the bottom it jumps so the newest sits two thirds down, and the next third
   * of a screen of streamed text fills in below without shifting anything
   * (every whole-screen shift costs Bluetooth time the input then waits for).
   */
  private fillOnLayout = true;

  private followFirst(current: number): number {
    const total = this.lines.length;
    if (total <= this.rows) return 0;
    if (current < total - this.rows) return Math.max(this.bottom(), total - Math.ceil((this.rows * 2) / 3));
    return Math.min(current, total - 1);
  }

  bottom(): number {
    return Math.max(0, this.lines.length - this.rows);
  }

  scrollBy(n: number) {
    const max = Math.max(this.bottom(), this.first);
    const to = Math.max(0, Math.min(max, this.first + n));
    this.first = to;
    this.follow = to >= this.bottom();
  }

  goLive() {
    this.follow = true;
    this.fillOnLayout = true;
    this.laidOutFor = "";
  }

  paint(ctx: LayerContext): GrayImage {
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height);
    this.ensureLayout(width, height);
    const g = this.grid;
    const x0 = 4;
    let y = 2;
    for (let r = 0; r < this.rows; r++) {
      const line = this.lines[this.first + r];
      if (line) {
        if (line.band) image.fillRect(0, y, width, g.pitch, BAND);
        g.drawSpans(image, x0, y, line.spans, this.cols);
        if (line.rule) {
          const used = line.spans.reduce((n, s) => n + [...s.text].length, 0);
          image.fillRect(x0 + (used + 1) * g.cellW, y + Math.floor(g.pitch / 2), width - x0 - (used + 1) * g.cellW, 1, SHADE.rule);
        }
      }
      y += g.pitch;
    }
    // scroll position
    if (this.lines.length > this.rows) {
      const track = this.rows * g.pitch;
      const thumb = Math.max(8, Math.floor((track * this.rows) / this.lines.length));
      const top = 2 + Math.floor(((track - thumb) * this.first) / Math.max(1, this.bottom()));
      image.fillRect(width - 2, top, 2, thumb, 110);
    }

    // the input box, like Claude Code's
    const boxTop = height - this.bottomRows() * g.pitch - 2;
    const ruleY = (row: number) => boxTop + row * g.pitch + Math.floor(g.pitch / 2);
    image.fillRect(0, ruleY(0), width, 1, 90);
    image.fillRect(0, ruleY(2), width, 1, 90);
    const inputY = boxTop + g.pitch;
    let input: { text: string; style: Style }[];
    if (this.draft.active) {
      const t = this.draft.text || this.draft.status || "Listening...";
      input = [{ text: "❯ ", style: "promptMark" }, { text: tail(t, this.cols - 4), style: this.draft.text ? "prompt" : "dim" }];
    } else if (this.voiceNote || this.draft.status) {
      // why the last hold did nothing (no microphone, no speech, model download)
      input = [{ text: "❯ ", style: "promptMark" }, { text: this.voiceNote || this.draft.status, style: "err" }];
    } else {
      const hint = "hold to talk · tap for menu";
      input = [{ text: "❯ ", style: "promptMark" }, { text: hint, style: "faint" }];
    }
    g.drawSpans(image, x0, inputY, input, this.cols);

    // status line
    const statusY = boxTop + 3 * g.pitch;
    const left = (this.busy() ? SPINNER[this.spin % SPINNER.length] + statusLeft(this.conv).slice(1) : statusLeft(this.conv)) +
      (this.title ? " · " + this.title : "");
    const more = Math.max(0, this.bottom() - this.first);
    const right = [
      this.note,
      !this.connected && this.sessionId ? "offline" : "",
      !this.follow && more > 0 ? `${more} more below` : "",
      this.conv.footer,
    ].filter(Boolean).join(" · ");
    const rightCols = Math.min([...right].length, Math.floor(this.cols / 2));
    g.drawSpans(image, x0, statusY, [{ text: left, style: "meta" }], this.cols - rightCols - 2);
    if (rightCols) g.drawSpans(image, x0 + (this.cols - rightCols) * g.cellW, statusY, [{ text: tail(right, rightCols), style: "dim" }], rightCols);
    return image;
  }

  handleInput(event: InputEvent): void {
    switch (event.type) {
      case "scroll-up": case "swipe-up":
        this.scrollBy(this.reversedScroll() ? SCROLL_LINES : -SCROLL_LINES);
        return;
      case "scroll-down": case "swipe-down":
        this.scrollBy(this.reversedScroll() ? -SCROLL_LINES : SCROLL_LINES);
        return;
      case "long-press":
        this.startTalking();
        return;
      case "long-press-release":
        this.releaseTalking();
        return;
      case "double-click":
        this.draft.cancel();
        shell.yieldFocusToSidebar();
        return;
    }
  }

  // ── menu ────────────────────────────────────────────────

  menuItems(): MenuItem[] {
    void this.refreshSessions().catch(() => {});
    const items: MenuItem[] = [];
    // only when the open session has lost its machine (the live feed also retries on its own)
    if (this.sessionId && !this.connected) {
      items.push({ label: "Reconnect", onSelect: (ctx) => {
        ctx.stack.clearToBase();
        void this.open(this.sessionId, this.server ?? undefined).catch((e) => this.fail(e));
      } });
    }
    if (this.pendingBlock()) items.push({ label: "Answer prompt", onSelect: (ctx) => { ctx.stack.clearToBase(); this.syncPrompt(true); } });
    if (!this.follow) items.push({ label: "Go to latest", onSelect: (ctx) => { this.goLive(); ctx.stack.clearToBase(); } });
    if (this.busy() && this.sessionId) {
      items.push({ label: "Interrupt", onSelect: (ctx) => {
        ctx.stack.clearToBase();
        void api.interrupt(this.cfg, this.sessionId).then(() => this.flash("interrupted"), (e) => this.fail(e));
      } });
    }
    items.push(
      { label: "Sessions", onSelect: () => { void this.showSessions(); } },
      { label: "Settings", onSelect: (ctx) => ctx.stack.push(flatMenu("Settings", this.settingsItems())) },
      { label: "Close Claude Code", onSelect: (ctx) => { ctx.stack.clearToBase(); shell.closeWindow(APP_ID); } },
    );
    return items;
  }

  settingsItems(): MenuItem[] {
    const current = this.fontSize();
    return [
      { label: `Text size: ${current}`, onSelect: (ctx) => ctx.stack.push(flatMenu("Text size", FONT_SIZES.map((n) => ({
        label: `${n === current ? "✓ " : ""}${n} px`,
        onSelect: (pick: LayerContext) => {
          setStringSetting(FONT_KEY, String(n));
          this.laidOutFor = "";
          pick.stack.clearToBase();
          this.render();
        },
      })))) },
      { label: `Scroll: ${this.reversedScroll() ? "reversed" : "natural"}`, onSelect: (ctx) => {
        setStringSetting(SCROLL_KEY, this.reversedScroll() ? "natural" : "reversed");
        ctx.stack.clearToBase();
        this.flash(`scroll ${this.reversedScroll() ? "reversed" : "natural"}`);
      } },
      { label: `Tool output: ${this.toolOutput() ? "on" : "off"}`, onSelect: (ctx) => {
        setStringSetting(TOOL_OUTPUT_KEY, this.toolOutput() ? "off" : "on");
        this.laidOutFor = "";
        ctx.stack.clearToBase();
        this.render();
      } },
      { label: "Machines", onSelect: (ctx) => ctx.stack.push(flatMenu("Machines", this.serverItems())) },
    ];
  }

  /** Scans even-cc's QR code with the phone camera and adds that PC. */
  async scanToAdd() {
    if (!isQrScannerAvailable()) {
      this.flash("no QR scanner");
      return;
    }
    this.flash("scan the even-cc QR code");
    let scanned: string | null;
    try {
      scanned = await scanQrCode();
    } catch (e) {
      this.fail(e);
      return;
    }
    if (scanned === null) {
      this.flash("scan cancelled");
      return;
    }
    const result = addFromLink(scanned);
    if (!result) {
      this.flash("not an even-cc QR code");
      return;
    }
    this.flash(`added ${result.server.name}`);
    await this.showSessions();
  }

  private serverItems(): MenuItem[] {
    const add: MenuItem = { label: "Add machine", onSelect: (ctx: LayerContext) => { ctx.stack.clearToBase(); void this.scanToAdd(); } };
    const servers = loadServers();
    if (!servers.length) return [add];
    return [add, ...servers.map((server) => ({
      label: `${server.name}${this.offline.includes(server.name) ? " · offline" : ""}`,
      description: server.url,
      onSelect: (ctx: LayerContext) => ctx.stack.push(flatMenu(server.name, [
        { label: "Remove", onSelect: (pick: LayerContext) => {
          removeServer(server.url);
          pick.stack.clearToBase();
          this.flash(`removed ${server.name}`);
        } },
      ])),
    }))];
  }

  /**
   * The session list. With one PC: its sessions. With several: the PCs
   * first, each opening its own sessions (a two-step pick, never mixed).
   */
  sessionMenu(): MenuLayer {
    const servers = loadServers();
    if (servers.length <= 1) return flatMenu("Sessions", this.serverSessionItems(servers[0] ?? null), WIDE_MENU);
    return flatMenu("Machines", servers.map((server) => {
      const count = this.sessions.filter((s) => s.server.url === server.url).length;
      const offline = this.offline.includes(server.name);
      return {
        label: `${server.url === this.server?.url ? "✓ " : ""}${server.name} · ${offline ? "offline" : `${count} session${count === 1 ? "" : "s"}`}`,
        onSelect: (ctx: LayerContext) => ctx.stack.push(flatMenu(server.name, this.serverSessionItems(server), WIDE_MENU)),
      };
    }));
  }

  /** One PC's sessions, newest first, "+ New session" on top. */
  private serverSessionItems(server: EvenCcServer | null): MenuItem[] {
    const items: MenuItem[] = [{ label: "New session", onSelect: (ctx: LayerContext) => { ctx.stack.clearToBase(); this.newSession(server); } }];
    if (server && this.offline.includes(server.name)) {
      items.push({ label: "Offline", disabled: true, onSelect: () => {} });
    }
    for (const s of this.sessions.filter((s) => !server || s.server.url === server.url).slice(0, 40)) {
      const folder = s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";
      items.push({
        label: fitLabel(`${s.id === this.sessionId ? "✓ " : ""}${s.title || s.id.slice(0, 8)} · ${ago(s.timestamp)}${folder ? " · " + folder : ""}`),
        description: s.cwd,
        onSelect: (ctx: LayerContext) => {
          ctx.stack.clearToBase();
          void this.open(s.id, s.server).catch((e) => this.fail(e));
        },
      });
    }
    return items;
  }

}

/** A permission prompt or question, floating over the conversation. */
class PromptLayer implements Layer {
  readonly paintOverBase = true;
  readonly dimUnderneath = 0.3;
  choice = 0;

  constructor(
    private readonly app: ClaudeCodeApp,
    readonly key: string,
    private readonly heading: string,
    private readonly body: string,
    private readonly choices: { label: string; act: () => Promise<unknown> }[],
    readonly acceptsText: boolean,
  ) {}

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    const { width, height } = ctx.stack.getBaseSize();
    const font = getDefaultSmallFont();
    const step = font.lineHeight + 4;
    const boxW = width - 48;
    const inner = boxW - 28;
    const bodyLines = this.body.split("\n").flatMap((p) => wrapText(font, p, inner)).slice(0, 8);
    const hint = this.acceptsText ? "slide: move · tap: choose · hold: answer by voice · 2x tap: hide" : "slide: move · tap: choose · 2x tap: hide";
    const draftLine = this.app.draft.active ? 1 : 0;
    const boxH = 14 + step * (1 + bodyLines.length + this.choices.length + 1 + draftLine) + 16;
    const bx = 24;
    const by = Math.max(4, height - boxH - this.app.inputTop() - 8);
    image.fillRect(bx, by, boxW, boxH, 1); // 0 is transparent on a layer canvas; 1 is opaque and dark
    image.drawRect(bx, by, boxW, boxH, 200);
    let y = by + 10;
    font.drawText(image, bx + 14, y, truncateText(font, this.heading, inner), 255);
    y += step + 2;
    for (const line of bodyLines) {
      font.drawText(image, bx + 14, y, line, 175);
      y += step;
    }
    y += 4;
    this.choices.forEach((c, i) => {
      const selected = i === this.choice;
      if (selected) image.fillRect(bx + 8, y - 2, boxW - 16, step, 60);
      font.drawText(image, bx + 14, y, truncateText(font, `${selected ? ">" : " "} ${i + 1}. ${c.label}`, inner), selected ? 255 : 190);
      y += step;
    });
    if (draftLine) {
      font.drawText(image, bx + 14, y, truncateText(font, "> " + (this.app.draft.text || this.app.draft.status), inner), 230);
      y += step;
    }
    font.drawText(image, bx + 14, y + 2, truncateText(font, hint, inner), 120);
    return image;
  }

  handleInput(event: InputEvent): void {
    switch (event.type) {
      case "scroll-up": case "swipe-up":
        this.choice = Math.max(0, this.choice - 1);
        return;
      case "scroll-down": case "swipe-down":
        this.choice = Math.min(this.choices.length - 1, this.choice + 1);
        return;
      case "click": {
        const c = this.choices[this.choice];
        if (c) void this.app.answer(this, c);
        return;
      }
      case "double-click":
        this.app.dismissPrompt(this);
        return;
      case "long-press":
        if (this.acceptsText) this.app.startTalking();
        return;
      case "long-press-release":
        this.app.releaseTalking();
        return;
    }
  }
}

/** Seconds a finished voice prompt waits before it sends itself. */
const SEND_COUNTDOWN = 2;
/*
 * No stereo depth for our layers: a layer at a nearer depth goes to the
 * glasses as a cached image, and after a few of those the left lens started
 * rejecting every cache command (connection loop) until its firmware was
 * reinstalled. The box stands out by dimming the conversation instead.
 */

/**
 * A finished voice prompt floating in front of everything, sending itself
 * after a countdown; a tap or double tap cancels it, holding talks again.
 */
class DraftLayer implements Layer {
  readonly paintOverBase = true;
  readonly dimUnderneath = 0.3;
  private left = SEND_COUNTDOWN;
  private timer: ReturnType<typeof setInterval> | null = null;
  private done = false;
  private stack: LayerStack | null = null;

  constructor(private readonly app: ClaudeCodeApp, readonly text: string) {}

  /** Starts the countdown; the app pushes the layer onto `stack` first. */
  start(stack: LayerStack) {
    this.stack = stack;
    this.timer = setInterval(() => {
      this.left--;
      if (this.left > 0) {
        this.app.render();
        return;
      }
      this.finish(true);
    }, 1000);
  }

  private finish(send: boolean) {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    removeLayer(this.stack ?? undefined, this);
    if (send) void this.app.sendPrompt(this.text);
    else this.app.flash("cancelled");
    this.app.render();
  }

  onRemoved() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.done = true;
  }

  paint(ctx: LayerContext, paintBelow: PaintBelow): GrayImage {
    const image = paintBelow();
    const { width, height } = ctx.stack.getBaseSize();
    const font = getDefaultSmallFont();
    const step = font.lineHeight + 4;
    const boxW = Math.min(width - 96, 440); // a compact box, not the full width
    const inner = boxW - 32;
    const lines = wrapText(font, this.text, inner).slice(-5);
    const boxH = 20 + step * (lines.length + 2);
    const bx = Math.floor((width - boxW) / 2);
    const by = Math.max(8, Math.floor((height - boxH) / 2));
    image.fillRect(bx, by, boxW, boxH, 1); // 0 is transparent on a layer canvas
    image.drawRect(bx, by, boxW, boxH, 230);
    image.drawRect(bx + 1, by + 1, boxW - 2, boxH - 2, 120);
    let y = by + 12;
    for (const line of lines) {
      font.drawText(image, bx + 16, y, line, 245);
      y += step;
    }
    // countdown bar: shrinks to nothing as the send approaches
    const barW = Math.round(((boxW - 32) * this.left) / SEND_COUNTDOWN);
    image.fillRect(bx + 16, y + 6, barW, 3, 200);
    font.drawText(image, bx + 16, y + step - 2, `sending in ${this.left} · tap to cancel`, 150);
    return image;
  }

  handleInput(event: InputEvent): void {
    switch (event.type) {
      case "click":
      case "double-click":
        this.finish(false);
        return;
      case "long-press":
        this.finish(false);
        this.app.startTalking();
        return;
    }
  }
}

function removeLayer(stack: LayerStack | undefined, layer: Layer) {
  if (!stack) return;
  // pop menus above it first (they belong to the moment the prompt was up)
  if (stack.popIfTop((l) => l === layer)) return;
  stack.remove?.(layer);
}

function tail(s: string, n: number): string {
  const chars = [...s];
  return chars.length <= n ? s : "..." + chars.slice(chars.length - n + 3).join("");
}

function ago(ts: string): string {
  const t = Date.parse(ts);
  if (!isFinite(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function createClaudeCodeWindow(options: InProcessAppOptions): InProcessWindow {
  const app = new ClaudeCodeApp(options);
  const win = createInProcessWindow({
    ...options,
    appId: APP_ID, windowId: APP_ID, title: "Claude Code", iconLetter: "C", icon: "terminal", closeable: true,
    // tall, not immersive: immersive drops the stereo shift the rest of the UI uses, a depth jump
    heightMode: "max",
    baseLayer: app, holdToTalk: true,
    isVoiceCapturing: () => app.draft.active,
    onSystemMenuOpened: () => app.draft.cancel(),
    onAppMenuOpened: () => app.draft.cancel(),
    setScreenOn: (on) => { if (!on) app.draft.cancel(); },
    setSurfaceVisible: (visible) => { if (!visible) app.draft.cancel(); options.setSurfaceVisible(visible); },
    menuItems: () => app.menuItems(),
    createMenuLayer: (title, items) => flatMenu(title, items),
    receiveTextInput: (text) => { if (!app.draft.active) void app.sendPrompt(text); },
    onClosed: () => { app.stop(); options.onClosed(); },
  });
  app.window = win;
  app.start();
  return win;
}
