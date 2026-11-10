// Copied from even-cc by tools/sync-faceclaw.sh; edit it there.
// Folds even-cc's SSE events (docs/even-protocol.md §5) into conversation
// blocks for the layout, plus what the status bar shows.

import { splitFooter, type Block } from "./layout";

export type Activity = "idle" | "busy" | "thinking" | "writing" | "tool" | "waiting";

export interface Conversation {
  blocks: Block[];
  activity: Activity;
  tool: string; // running tool, for the status bar
  footer: string; // last reply's "41s · 1 tool · ctx 3%"
  elapsedMs: number;
  pendingPermission: boolean;
  pendingQuestion: boolean;
}

export function emptyConversation(): Conversation {
  return { blocks: [], activity: "idle", tool: "", footer: "", elapsedMs: 0, pendingPermission: false, pendingQuestion: false };
}

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

export function fromHistory(items: HistoryItem[]): Conversation {
  const c = emptyConversation();
  for (const it of items) c.blocks.push(it.role === "user" ? { kind: "prompt", text: it.text } : { kind: "text", text: it.text });
  return c;
}

type Ev = { type: string; [k: string]: any };

const toolIndex = new WeakMap<Conversation, Map<string, number>>();

/** Applies one event; returns true if anything visible changed. */
export function apply(c: Conversation, ev: Ev): boolean {
  const last = c.blocks[c.blocks.length - 1];
  const tools = toolIndex.get(c) ?? new Map<string, number>();
  toolIndex.set(c, tools);
  switch (ev.type) {
    case "user_prompt":
      c.blocks.push({ kind: "prompt", text: String(ev.text ?? "") });
      c.footer = "";
      return true;
    case "status":
      switch (ev.state) {
        case "busy":
          c.activity = "busy";
          return true;
        case "idle":
          c.activity = "idle";
          c.tool = "";
          return true;
        case "think_start":
          c.activity = "thinking";
          return true;
        case "think_end":
          c.activity = "busy";
          return true;
        case "text_start":
          c.activity = "writing";
          if (last?.kind !== "text") c.blocks.push({ kind: "text", text: "" });
          return true;
        case "text_end":
          c.activity = "busy";
          return true;
      }
      return false;
    case "text_delta": {
      const t = String(ev.text ?? "");
      if (/^\n*— /.test(t) && last?.kind === "text") {
        // even-cc's reply footer: status bar, not the reply
        c.footer = t.replace(/^\n*— /, "");
        return true;
      }
      if (last?.kind === "text") last.text += t;
      else c.blocks.push({ kind: "text", text: t });
      return true;
    }
    case "tool_start":
      tools.set(ev.toolId, c.blocks.length);
      c.blocks.push({ kind: "tool", name: ev.name, summary: ev.name, state: "running" });
      c.activity = "tool";
      c.tool = ev.name;
      return true;
    case "tool_end": {
      const i = tools.get(ev.toolId);
      const b = i !== undefined ? c.blocks[i] : undefined;
      const output = typeof ev.detail?.output === "string" ? ev.detail.output : undefined;
      const done = /· (done|exit 0)\b/.test(ev.summary) || !/· (running|\d+ tools · \d)/.test(ev.summary);
      const state = /· (failed|stopped)\b|· exit [1-9]/.test(ev.summary) ? "error" : done ? "done" : "running";
      if (b && b.kind === "tool") Object.assign(b, { summary: ev.summary, output: output ?? b.output, state });
      else {
        tools.set(ev.toolId, c.blocks.length);
        c.blocks.push({ kind: "tool", name: ev.name, summary: ev.summary, output, state });
      }
      if (c.tool === ev.name) c.tool = "";
      return true;
    }
    case "permission_request":
      c.blocks.push({ kind: "permission", tool: ev.toolName, description: ev.description, detail: ev.detail ?? "",
        options: (ev.options ?? []).map((o: { text: string }) => o.text) });
      c.pendingPermission = true;
      c.activity = "waiting";
      return true;
    case "permission_result": {
      const i = findLast(c.blocks, (b) => b.kind === "permission");
      const verdict = ev.decision === "denied" ? "denied" : ev.decision === "always" ? "always allowed" : "allowed";
      if (i >= 0) c.blocks[i] = { kind: "notice", title: verdict, text: ev.summary || ev.toolName };
      c.pendingPermission = false;
      return true;
    }
    case "user_question":
      for (const q of ev.questions ?? [])
        c.blocks.push({ kind: "question", question: q.question || q.header, options: (q.options ?? []).map((o: { label: string }) => o.label) });
      c.pendingQuestion = true;
      c.activity = "waiting";
      return true;
    case "question_answer": {
      const i = findLast(c.blocks, (b) => b.kind === "question");
      const answers = Object.values(ev.answers ?? {}).join(", ");
      if (i >= 0) c.blocks[i] = { kind: "notice", title: "answered", text: answers };
      c.pendingQuestion = false;
      return true;
    }
    case "result": {
      const [, footer] = splitFooter(String(ev.text ?? ""));
      if (footer) c.footer = footer;
      if (!ev.success && ev.text) c.blocks.push({ kind: "error", text: ev.text });
      c.tool = "";
      return true;
    }
    case "running_stats":
      c.elapsedMs = ev.durationMs ?? c.elapsedMs;
      return false; // status-bar only; not worth a redraw on its own
    case "notification":
      c.blocks.push({ kind: "notice", title: ev.title, text: ev.message });
      return true;
    case "error":
      c.blocks.push({ kind: "error", text: ev.message });
      return true;
    case "task_progress":
      c.tool = `${ev.completed}/${ev.total} ${ev.current ?? ""}`.trim();
      return true;
  }
  return false;
}

function findLast<T>(a: T[], f: (x: T) => boolean): number {
  for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i;
  return -1;
}

export function statusLeft(c: Conversation): string {
  const label: Record<Activity, string> = {
    idle: "○ idle", busy: "● working", thinking: "● thinking", writing: "● writing", tool: "● running", waiting: "? waiting for you",
  };
  return label[c.activity] + (c.tool && c.activity !== "idle" ? " · " + c.tool : "");
}
