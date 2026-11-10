// Copied from even-cc by tools/sync-faceclaw.sh; edit it there.
// Conversation blocks -> styled, wrapped lines for a fixed number of columns.
// Looks like Claude Code in a terminal: ❯ prompts on a shaded band, ⏺ replies
// with markdown rendered (not shown as symbols), ⏺ Tool(args) with ⎿ output.

export type Style =
  | "text" | "bold" | "code" | "dim" | "faint" | "heading" | "link"
  | "prompt" | "promptMark" | "bullet" | "tool" | "toolArg" | "toolRunning" | "err"
  | "rule" | "meta" | "ask" | "option";

export interface Span {
  text: string;
  style: Style;
}

export interface Line {
  spans: Span[];
  band?: boolean; // shaded background (the user's prompt)
  rule?: boolean; // a horizontal rule across the line
}

export type Block =
  | { kind: "prompt"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string; output?: string; state: "running" | "done" | "error" }
  | { kind: "notice"; title: string; text: string }
  | { kind: "permission"; tool: string; description: string; detail: string; options: string[] }
  | { kind: "question"; question: string; options: string[] }
  | { kind: "error"; text: string }
  | { kind: "meta"; text: string };

export interface LayoutOptions {
  cols: number;
  toolOutputLines: number; // ⎿ lines shown per tool (0 = summary only)
}

// ── wrapping ────────────────────────────────────────────────

/** Splits spans into words (keeping whitespace runs) with their styles. */
function tokens(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) for (const t of s.text.match(/\s+|\S+/g) ?? []) out.push({ text: t, style: s.style });
  return out;
}

const len = (s: string) => [...s].length;

function pushSpan(line: Span[], text: string, style: Style) {
  const last = line[line.length - 1];
  if (last && last.style === style) last.text += text;
  else line.push({ text, style });
}

/**
 * Word-wraps spans to cols. first prefixes the first line, cont every other
 * line (hanging indent). Words longer than a line are broken.
 */
export function wrap(spans: Span[], cols: number, first: Span[] = [], cont: Span[] = [], extra: Partial<Line> = {}): Line[] {
  const lines: Line[] = [];
  let cur: Span[] = first.map((s) => ({ ...s }));
  let width = first.reduce((n, s) => n + len(s.text), 0);
  let atStart = true; // nothing but the prefix on this line yet
  const newline = () => {
    lines.push({ spans: cur, ...extra });
    cur = cont.map((s) => ({ ...s }));
    width = cont.reduce((n, s) => n + len(s.text), 0);
    atStart = true;
  };
  for (const tok of tokens(spans)) {
    const isSpace = /^\s+$/.test(tok.text);
    if (isSpace) {
      if (atStart) continue; // no leading blanks after a wrap
      if (width + len(tok.text) >= cols) {
        newline();
        continue;
      }
      pushSpan(cur, tok.text, tok.style);
      width += len(tok.text);
      continue;
    }
    let chars = [...tok.text];
    while (chars.length) {
      const room = cols - width;
      if (chars.length <= room) {
        pushSpan(cur, chars.join(""), tok.style);
        width += chars.length;
        atStart = false;
        break;
      }
      const lineRoom = cols - cont.reduce((n, s) => n + len(s.text), 0);
      if (!atStart && chars.length <= lineRoom) {
        newline(); // move the whole word down
        continue;
      }
      pushSpan(cur, chars.slice(0, room).join(""), tok.style); // break a long word
      chars = chars.slice(room);
      newline();
    }
  }
  if (!atStart || lines.length === 0) lines.push({ spans: cur, ...extra });
  // drop trailing spaces
  for (const l of lines) {
    const last = l.spans[l.spans.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, "");
  }
  return lines;
}

// ── markdown ────────────────────────────────────────────────

/** Inline markdown: **bold**, `code`, *em*, [text](url), <url>. */
export function inline(text: string, base: Style = "text"): Span[] {
  const out: Span[] = [];
  const re = /(\*\*|__)(.+?)\1|`([^`]+)`|\[([^\]]+)\]\([^)]*\)|(?<![\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index), style: base });
    if (m[2] !== undefined) out.push({ text: m[2], style: base === "heading" ? "heading" : "bold" });
    else if (m[3] !== undefined) out.push({ text: m[3], style: "code" });
    else if (m[4] !== undefined) out.push({ text: m[4], style: "link" });
    else out.push({ text: m[5], style: base });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), style: base });
  return out;
}

const sp = (text: string, style: Style = "text"): Span => ({ text, style });

/** Markdown text -> lines, indented under a ⏺ bullet. */
function markdown(text: string, cols: number, bullet: Span[], indent: string): Line[] {
  const out: Line[] = [];
  const src = text.replace(/\r/g, "").split("\n");
  let first = true;
  let inFence = false;
  let blankPending = false;
  const lead = () => {
    const l = first ? bullet : [sp(indent)];
    first = false;
    return l;
  };
  const emit = (ls: Line[]) => {
    if (blankPending && out.length) out.push({ spans: [] });
    blankPending = false;
    out.push(...ls);
  };
  for (const raw of src) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // code: no reflow, hard-wrapped under a gutter
      emit(wrap([sp(raw.replace(/\t/g, "  "), "code")], cols, [...lead(), sp("│ ", "faint")], [sp(indent), sp("│ ", "faint")]));
      continue;
    }
    const line = raw.trimEnd();
    if (line.trim() === "") {
      blankPending = true;
      continue;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*(#{1,6})\s+(.*)$/))) {
      emit(wrap(inline(m[2], "heading"), cols, lead(), [sp(indent)]));
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      emit([{ spans: lead(), rule: true }]);
    } else if ((m = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
      const depth = Math.min(3, Math.floor(m[1].length / 2));
      const mark = /\d/.test(m[2]) ? m[2] + " " : "• ";
      const pad = indent + "  ".repeat(depth);
      const l = first ? [...bullet, sp("  ".repeat(depth))] : [sp(pad)];
      first = false;
      emit(wrap(inline(m[3]), cols, [...l, sp(mark, "dim")], [sp(pad + " ".repeat(len(mark)))]));
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
      emit(wrap(inline(m[1], "dim"), cols, [...lead(), sp("▌ ", "faint")], [sp(indent), sp("▌ ", "faint")]));
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      // table row: monospace keeps it aligned; separator rows become a rule
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) emit([{ spans: lead(), rule: true }]);
      else {
        const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
        const spans: Span[] = [];
        cells.forEach((c, i) => {
          if (i) spans.push(sp(" │ ", "faint"));
          spans.push(...inline(c));
        });
        emit(wrap(spans, cols, lead(), [sp(indent)]));
      }
    } else {
      emit(wrap(inline(line.trim()), cols, lead(), [sp(indent)]));
    }
  }
  if (first) out.push({ spans: bullet });
  return out;
}

// ── blocks ──────────────────────────────────────────────────

const FOOTER = /\n*— ([^\n]*)$/; // even-cc's reply footer

/** Splits even-cc's "— 41s · 1 tool · ctx 3%" footer off a reply. */
export function splitFooter(text: string): [string, string | undefined] {
  const m = text.match(FOOTER);
  return m ? [text.slice(0, m.index), m[1]] : [text, undefined];
}

function toolLines(b: Extract<Block, { kind: "tool" }>, o: LayoutOptions): Line[] {
  // even-cc summaries look like "Bash: Run tests · exit 0 · 212 lines"
  // or "PowerShell List files" (no colon): drop the repeated name either way
  let arg = b.summary.startsWith(b.name + ":") || b.summary.startsWith(b.name + " ") ? b.summary.slice(b.name.length + 1).trim() : b.summary;
  if (arg === b.name) arg = "";
  const head: Span[] = [sp("⏺ ", b.state === "running" ? "toolRunning" : b.state === "error" ? "err" : "bullet"), sp(b.name, "tool")];
  const body: Span[] = arg ? [sp("(", "dim"), sp(arg, "toolArg"), sp(")", "dim")] : [];
  const out = wrap(body, o.cols, head, [sp("  ")]);
  if (o.toolOutputLines > 0 && b.output) {
    const rows = b.output.replace(/\r/g, "").split("\n").filter((l) => l.trim() !== "");
    const shown = rows.slice(0, o.toolOutputLines);
    shown.forEach((r, i) => {
      const pre = i === 0 ? [sp("  "), sp("⎿ ", "faint")] : [sp("    ")];
      const ws = wrap([sp(r, "dim")], o.cols, pre, [sp("    ")]);
      out.push(ws[0]); // one row per output line: output is a glimpse, not the record
    });
    if (rows.length > shown.length) out.push({ spans: [sp("    "), sp(`… +${rows.length - shown.length} line${rows.length - shown.length === 1 ? "" : "s"}`, "faint")] });
  }
  return out;
}

export function layout(blocks: Block[], o: LayoutOptions): Line[] {
  const out: Line[] = [];
  let prev: Block["kind"] | undefined;
  for (const b of blocks) {
    // Gaps: a blank line between blocks, except a tool right after a tool.
    if (prev && !(prev === "tool" && b.kind === "tool")) out.push({ spans: [] });
    switch (b.kind) {
      case "prompt":
        out.push(...wrap([sp(b.text.trim(), "prompt")], o.cols, [sp("❯ ", "promptMark")], [sp("  ")], { band: true }));
        break;
      case "text":
        out.push(...markdown(splitFooter(b.text)[0], o.cols, [sp("⏺ ", "bullet")], "  "));
        break;
      case "tool":
        out.push(...toolLines(b, o));
        break;
      case "notice":
        out.push(...wrap([sp(b.title ? b.title + ": " : "", "dim"), sp(b.text, "dim")], o.cols, [sp("· ", "faint")], [sp("  ")]));
        break;
      case "error":
        out.push(...wrap([sp(b.text, "err")], o.cols, [sp("✗ ", "err")], [sp("  ")]));
        break;
      case "meta":
        out.push({ spans: [sp(" ".repeat(Math.max(0, o.cols - len(b.text))) + b.text, "faint")] });
        break;
      case "permission": {
        out.push(...wrap([sp(b.tool, "tool"), sp("  " + b.description, "toolArg")], o.cols, [sp("? ", "ask")], [sp("  ")]));
        if (b.detail) out.push(...wrap([sp(b.detail, "code")], o.cols, [sp("  "), sp("│ ", "faint")], [sp("  "), sp("│ ", "faint")]));
        out.push({ spans: [sp("  "), ...b.options.flatMap((t, i) => [sp(i ? "   " : ""), sp(`${i + 1}`, "ask"), sp(" " + t, "option")])] });
        break;
      }
      case "question": {
        out.push(...wrap(inline(b.question), o.cols, [sp("? ", "ask")], [sp("  ")]));
        b.options.forEach((t, i) => out.push(...wrap([sp(t, "option")], o.cols, [sp("  "), sp(`${i + 1} `, "ask")], [sp("    ")])));
        break;
      }
    }
    prev = b.kind;
  }
  return out;
}
