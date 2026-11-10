// Claude Code app: drives the real app (layout, prompts, voice, gestures)
// against a fake even-cc, with the real Terminus fonts and GrayImage, and
// writes the frames it paints to .test-build/claude-code-*.png.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const ts = require('typescript');

const root = path.join(__dirname, '..');

/** Loads app TS files recursively; `stubs` maps resolved module paths (from app/) to stand-ins. */
function loader(stubs) {
  const cache = new Map();
  function loadFile(rel) {
    if (cache.has(rel)) return cache.get(rel).exports;
    const file = path.join(root, 'app', rel + '.ts');
    const module = { exports: {} };
    cache.set(rel, module);
    const source = fs.readFileSync(file, 'utf8');
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    vm.runInNewContext(js, {
      exports: module.exports, module, console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math,
      require(name) {
        if (!name.startsWith('.')) {
          assert.ok(name in stubs, `Unexpected import ${name} in ${rel}`);
          return stubs[name];
        }
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), name));
        if (target in stubs) return stubs[target];
        return loadFile(target);
      },
    });
    return module.exports;
  }
  return loadFile;
}

function fakeServer() {
  const calls = [];
  let follower = null;
  const s = {
    calls,
    sessions: [{ id: 's1', title: 'even-cc', timestamp: new Date().toISOString(), cwd: 'D:/clients/even-cc', status: null }],
    history: [
      { role: 'user', text: 'fix the flaky websocket test' },
      { role: 'assistant', text: 'The test races the **heartbeat**. I made the ping interval injectable and added a `Clock` to the server, so the test can step time.' },
    ],
    emit(ev) { follower?.onEvent(ev); },
    api: {
      listSessions: async () => s.sessions,
      machineInfo: async () => s.machine ?? Promise.reject(new Error('old even-cc')),
      history: async (_c, id) => ({ history: s.history, openElsewhere: id === 's1' ? s.elsewhere : undefined }),
      ApiError: class extends Error { constructor(m, status, detail) { super(m); this.status = status; this.detail = detail; } },
      answerPermission: async (_c, sid, d) => { calls.push(['permission', sid, d]); },
      answerQuestion: async (_c, sid, a) => { calls.push(['question', sid, a]); },
      sendPrompt: async (_c, sid, t, fork) => {
        if (fork) { calls.push(['fork', sid, t]); return { sessionId: 'fork1' }; }
        if (sid === 's1' && s.held) throw new s.api.ApiError('409', 409, `Open in ${s.held}. Close it there, or fork it here.`);
        calls.push(['prompt', sid, t]);
        return { sessionId: sid || 'new1' };
      },
      interrupt: async (_c, sid) => { calls.push(['interrupt', sid]); },
      follow: (_c, sid, onEvent, onState) => { follower = { sid, onEvent }; setTimeout(() => onState(true)); return () => { follower = null; }; },
    },
  };
  return s;
}

function fakeStack(base, size) {
  const layers = [base];
  return {
    layers,
    getBaseSize: () => size,
    isAtBase: () => layers.length === 1,
    push: (l) => layers.push(l),
    popIfTop: (p) => (layers.length > 1 && p(layers.at(-1)) ? (layers.pop(), true) : false),
    remove: (l) => { const i = layers.indexOf(l); if (i > 0) { layers.splice(i, 1); return true; } return false; },
    clearToBase: () => layers.splice(1),
    top: () => layers.at(-1),
  };
}

let servers = [{ name: 'mule', url: 'http://pc:3456', token: 't' }];

function setup() {
  const settings = new Map();
  const transcripts = new Set();
  const voice = { onTranscript: (f) => (transcripts.add(f), () => transcripts.delete(f)), onStatus: () => () => {} };
  const server = fakeServer();
  let windowOptions;
  const nativescript = { knownFolders: { currentApp: () => ({ getFile: (p) => ({ readTextSync: () => fs.readFileSync(path.join(root, 'app', p), 'utf8') }) }) } };
  const load = loader({
    '@nativescript/core': nativescript,
    'native/settings-store': { getStringSetting: (k, d) => settings.get(k) ?? d, setStringSetting: (k, v) => settings.set(k, v) },
    'native/asr-model': { asrModelState: () => ({ status: 'ready' }), isAsrModelReady: () => true, onAsrModelStateChanged: () => () => {}, startAsrModelDownload() {} },
    'ui/dashboard-settings': {
      voiceProviderSetting: { get: () => 'onboard' },
      ConfigSettingString: class { constructor(o) { Object.assign(this, o); } get() { return settings.get(this.storageKey) ?? this.defaultValue; } set(v) { settings.set(this.storageKey, v); } displayValue() { return this.formatValue(this.get()); } },
      textSettingMenuItem: (s) => ({ label: s.label, onSelect() {} }),
    },
    'graphics/ui-fonts': { getDefaultSmallFont: () => load('graphics/bdffont').getTerminusFont(16, false) },
    'ui/window-menu': { WINDOW_MENU_LAYOUT: {} },
    'ui/menu': { MenuLayer: class { constructor(title, items) { this.title = title; this.items = items; this.selectedIndex = 0; } setItems(items, i) { this.items = items; if (i != null) this.selectedIndex = i; } } },
    'ui/gestures': { GESTURE_SHORT_THEN_LONG_PRESS: 'tap-hold', gestureHints: () => '' },
    'ui/shell/in-process-window': { createInProcessWindow: (o) => { windowOptions = o; return null; } },
    'ui/shell/shell': { shell: { prepareChatVoiceCapture: async () => true, yieldFocusToSidebar() {}, closeWindow() {} } },
    'native/voice-control': { voiceControlBridge: voice },
    'ui/shell/voice-activity': { voiceActivity: { setActive() {} } },
    'apps/claude-code/api': server.api,
    'apps/claude-code/servers': { loadServers: () => servers, removeServer() {} },
    'native/qr-scan': { isQrScannerAvailable: () => true, scanQrCode: async () => null },
  });
  const mod = load('apps/claude-code/claude-code-app');
  const { GrayImage } = load('graphics/image');
  const options = { actions: { startVoiceCapture: async () => {}, stopVoiceCapture: async () => {} }, onClosed() {}, setSurfaceVisible() {} };
  // createClaudeCodeWindow wires a real window; build the app by hand around a fake stack instead
  const app = new mod.ClaudeCodeApp(options);
  const stack = fakeStack(app, { width: 640, height: 480 });
  let renders = 0;
  app.window = { stack, requestRender: () => renders++ };
  const say = (text, isFinal) => { for (const f of transcripts) f({ text, isFinal }); };
  const paint = () => {
    const ctx = { stack, actions: options.actions };
    let image = app.paint(ctx);
    for (const layer of stack.layers.slice(1)) image = layer.paint(ctx, () => image) ?? image;
    return image.withDrawsBaked();
  };
  const input = async (type) => { await stack.top().handleInput({ type, source: 'ring', timestampMs: Date.now() }, { stack, actions: options.actions }); };
  return { app, server, stack, say, paint, input, GrayImage, renders: () => renders, windowOptions: () => windowOptions };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function writePng(name, image) {
  const { width, height, pixels } = image;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const v = pixels[y * width + x] / 255, o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(40 * v); raw[o + 1] = Math.round(255 * Math.pow(v, 0.8)); raw[o + 2] = Math.round(90 * v);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const out = path.join(root, '.test-build');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, name), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

test('opens on the session list, New session first', async () => {
  const t = setup();
  t.app.start();
  await tick(10);
  const menu = t.stack.top();
  assert.equal(menu.title, 'Sessions');
  assert.equal(menu.items[0].label, 'New session');
  assert.match(menu.items[1].label, /^even-cc · .* · even-cc$/);
  t.app.stop();
});

test('opens the latest session and paints it like Claude Code on the full panel', async () => {
  const t = setup();
  t.app.start();
  await tick(10);
  t.stack.clearToBase();
  await t.app.open('s1');
  assert.equal(t.app.sessionId, 's1');
  t.server.emit({ type: 'tool_start', name: 'Bash', toolId: 'x1' });
  t.server.emit({ type: 'tool_end', name: 'Bash', toolId: 'x1', summary: 'Bash: go test ./internal/server', detail: { input: {}, output: 'ok  even-cc/internal/server 2.4s' } });
  t.server.emit({ type: 'text', text: 'All tests pass.' });
  const image = t.paint();
  assert.equal(image.width, 640);
  assert.equal(image.height, 480);
  assert.ok(t.app.cols >= 75, `cols ${t.app.cols}`);
  writePng('claude-code-view.png', image);
  let lit = 0;
  for (const v of image.pixels) if (v > 100) lit++;
  assert.ok(lit > 2000, 'frame has text');
  t.app.stop();
});

test('a permission prompt floats up; slide picks, tap answers, and it goes away', async () => {
  const t = setup();
  t.app.start();
  await tick(10);
  t.stack.clearToBase();
  await t.app.open('s1');
  t.server.emit({ type: 'permission_request', toolName: 'Bash', description: 'Run the tests', detail: 'go test ./...' });
  await tick();
  const blocks = t.app.conv.blocks.map((b) => b.kind);
  assert.ok(t.app.conv.pendingPermission, `pending permission; blocks ${blocks}`);
  assert.equal(t.stack.layers.length, 2, 'prompt layer pushed');
  writePng('claude-code-permission.png', t.paint());
  await t.input('scroll-down');
  await t.input('click');
  await tick();
  assert.deepEqual(t.server.calls.at(-1), ['permission', 's1', 'allowAlways']);
  assert.equal(t.stack.layers.length, 1, 'prompt removed after answering');
  t.app.stop();
});

test('hold to talk shows the words live; release floats a draft that sends after 2 s; a tap or double tap cancels', async () => {
  const t = setup();
  t.app.start();
  await tick(10);
  t.stack.clearToBase();
  await t.app.open('s1');
  await t.input('long-press');
  await tick();
  t.say('add a retry', false);
  assert.match(t.app.draft.text, /add a retry/);
  writePng('claude-code-listening.png', t.paint());
  t.say('add a retry to the upload', true);
  await t.input('long-press-release');
  await tick(1700);
  assert.equal(t.stack.layers.length, 2, 'draft layer up');
  assert.equal(t.stack.top().depth, 8, 'floats in front');
  writePng('claude-code-draft.png', t.paint());
  assert.equal(t.server.calls.filter((c) => c[0] === 'prompt').length, 0, 'not sent yet');
  await tick(3200);
  assert.deepEqual(t.server.calls.at(-1), ['prompt', 's1', 'add a retry to the upload']);
  assert.equal(t.stack.layers.length, 1, 'gone after sending');

  for (const cancel of ['click', 'double-click']) {
    await t.input('long-press');
    await tick();
    t.say('never mind', true);
    await t.input('long-press-release');
    await tick(1700);
    assert.equal(t.stack.layers.length, 2);
    await t.input(cancel);
    assert.equal(t.stack.layers.length, 1, `${cancel} closes it`);
    await tick(3200);
  }
  assert.equal(t.server.calls.filter((c) => c[0] === 'prompt').length, 1, 'cancelled drafts not sent');
  t.app.stop();
});

test('a session open elsewhere is read only, refreshes, and forks on demand', async () => {
  const t = setup();
  t.app.start();
  await tick(10);
  t.stack.clearToBase();
  t.server.elsewhere = 'VS Code';
  t.server.held = 'VS Code';
  await t.app.open('s1');
  assert.equal(t.app.elsewhere, 'VS Code');
  writePng('claude-code-elsewhere.png', t.paint());

  // talking offers the fork instead of sending
  await t.app.sendPrompt('carry on');
  assert.equal(t.server.calls.length, 0, 'nothing sent to a held session');
  assert.equal(t.stack.layers.length, 2, 'fork prompt up');
  await t.input('click'); // "Fork and send"
  await tick(10);
  assert.deepEqual(t.server.calls.at(-1), ['fork', 's1', 'carry on']);
  assert.equal(t.app.sessionId, 'fork1');
  assert.equal(t.app.elsewhere, '');

  // back on the held session: closing it there makes it writable here
  await t.app.open('s1');
  t.server.history = [...t.server.history, { role: 'user', text: 'typed in VS Code' }];
  await tick(3200);
  assert.match(JSON.stringify(t.app.conv.blocks), /typed in VS Code/, 'refreshed');
  t.server.elsewhere = undefined;
  t.server.held = undefined;
  await tick(3200);
  assert.equal(t.app.elsewhere, '');
  await t.app.sendPrompt('now here');
  assert.deepEqual(t.server.calls.at(-1), ['prompt', 's1', 'now here']);

  // held since opening: the 409 turns it read only and offers the fork
  t.server.held = 'a terminal';
  await t.app.sendPrompt('again');
  assert.equal(t.app.elsewhere, 'a terminal');
  assert.equal(t.stack.layers.length, 2);
  await t.input('double-click');
  t.app.stop();
});

test('the session list shows the machine account and plan usage', async () => {
  const t = setup();
  const reset = Math.floor(Date.now() / 1000) + 3600;
  t.server.machine = { name: 'mule', account: { email: 'me@example.com', subscriptionType: 'max' },
    usage: { windows: { five_hour: { utilization: 0.21, resetsAt: reset }, seven_day: { utilization: 0.243, resetsAt: reset + 86400 * 3 } }, at: new Date().toISOString() } };
  t.app.start();
  await tick(10);
  await t.app.refreshSessions();
  await tick(10);
  const menu = t.app.sessionMenu();
  assert.equal(menu.title, 'Sessions · 5h 21% · wk 24%');
  const labels = menu.items.map((i) => i.label);
  assert.equal(labels[0], 'New session', 'opens on New session');
  assert.ok(labels.includes('me@example.com · max'), labels.join(' | '));
  assert.ok(labels.some((l) => /^5h resets .* · wk resets /.test(l)), labels.join(' | '));
  t.app.stop();
});

test('a question can be answered by voice', async () => {
  const t = setup();
  t.app.start();
  await tick(10);
  t.stack.clearToBase();
  await t.app.open('s1');
  t.server.emit({ type: 'user_question', questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] });
  await tick();
  assert.ok(t.app.conv.pendingQuestion, 'pending question');
  assert.equal(t.stack.layers.length, 2);
  await t.input('long-press');
  await tick();
  t.say('use duckdb', true);
  await t.input('long-press-release');
  await tick(1700);
  assert.deepEqual(t.server.calls.at(-1), ['question', 's1', 'use duckdb']);
  t.app.stop();
});

test('ring scroll moves through history and the menu offers sessions', async () => {
  const t = setup();
  t.server.history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i} ` + 'words '.repeat(30) }));
  t.app.start();
  await tick(10);
  t.stack.clearToBase();
  await t.app.open('s1');
  t.paint();
  const bottom = t.app.first;
  await t.input('scroll-up');
  assert.equal(t.app.first, bottom - 3);
  assert.equal(t.app.follow, false);
  const labels = t.app.menuItems().map((m) => m.label);
  assert.ok(labels.includes('Sessions') && !labels.includes('New session') && labels.includes('Go to latest'), labels.join(', '));
  t.app.stop();
});

test('Text size opens on the current size and stays open, moving the check mark', async () => {
  const t = setup();
  t.app.start();
  await tick(10);
  t.stack.clearToBase();
  await t.app.open('s1');
  const ctx = { stack: t.stack, actions: {} };
  const item = t.app.settingsItems().find((m) => m.label.startsWith('Text size'));
  item.onSelect(ctx);
  const sizes = t.stack.top();
  assert.equal(sizes.title, 'Text size');
  assert.equal(JSON.stringify(sizes.items.map((i) => i.label)), JSON.stringify(['12 px', '✓ 14 px', '16 px', '18 px', '20 px']));
  assert.equal(sizes.selectedIndex, 1, 'starts on the current size');
  sizes.items[3].onSelect(ctx);
  assert.equal(t.app.fontSize(), 18);
  assert.equal(t.stack.top(), sizes, 'still open');
  assert.equal(JSON.stringify(sizes.items.map((i) => i.label)), JSON.stringify(['12 px', '14 px', '16 px', '✓ 18 px', '20 px']));
  sizes.items[0].onSelect(ctx);
  assert.equal(t.app.fontSize(), 12);
  t.app.stop();
});

test('streaming text moves the view in steps, not a line at a time', async () => {
  const t = setup();
  t.server.history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i} ` + 'words '.repeat(20) }));
  t.app.start();
  await tick(10);
  t.stack.clearToBase();
  await t.app.open('s1');
  t.paint();
  assert.equal(t.app.first, t.app.bottom(), 'opens on a full screen');
  const firsts = new Set();
  for (let i = 0; i < 40; i++) {
    t.server.emit({ type: 'text', text: 'streamed line ' + i + '\n\n' });
    t.paint();
    firsts.add(t.app.first);
    assert.ok(t.app.lines.length - t.app.first <= t.app.rows, 'newest line on screen');
  }
  assert.ok(firsts.size <= Math.ceil(80 / Math.ceil(t.app.rows / 3)) + 1, `${firsts.size} distinct positions over 40 streamed lines`);
  t.app.stop();
});

test('scroll direction can be reversed in Settings', async () => {
  const t = setup();
  t.server.history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `message ${i} ` + 'words '.repeat(30) }));
  t.app.start();
  await tick(10);
  t.stack.clearToBase();
  await t.app.open('s1');
  t.paint();
  const bottom = t.app.first;
  const ctx = { stack: t.stack, actions: {} };
  const scroll = t.app.settingsItems().find((m) => m.label.startsWith('Scroll'));
  assert.equal(scroll.label, 'Scroll: natural');
  scroll.onSelect(ctx);
  assert.equal(t.app.settingsItems().find((m) => m.label.startsWith('Scroll')).label, 'Scroll: reversed');
  await t.input('scroll-down'); // reversed: down goes back in history
  assert.equal(t.app.first, bottom - 3);
  t.app.stop();
});

test('with several PCs, the list picks a PC first, then that PC\'s sessions', async () => {
  const saved = servers;
  servers = [{ name: 'mule', url: 'http://pc:3456', token: 't' }, { name: 'mule (WSL)', url: 'http://pc:3457', token: 'u' }];
  try {
    const t = setup();
    t.app.start();
    await tick(10);
    const pcs = t.stack.top();
    assert.equal(pcs.title, 'Machines');
    assert.equal(JSON.stringify(pcs.items.map((i) => i.label)), JSON.stringify(['mule · 1 session', 'mule (WSL) · 1 session']));
    pcs.items[1].onSelect({ stack: t.stack, actions: {} });
    const sessions = t.stack.top();
    assert.equal(sessions.title, 'mule (WSL)');
    assert.equal(sessions.items[0].label, 'New session');
    assert.equal(sessions.items.length, 2, 'only that PC\'s session');
    sessions.items[1].onSelect({ stack: t.stack, actions: {} });
    await tick(10);
    assert.equal(t.app.server.name, 'mule (WSL)');
    t.app.stop();
  } finally {
    servers = saved;
  }
});

test('an evencc://add link adds the PC, its voice proxy and its terminal', () => {
  const store = new Map();
  const set = (key) => ({ value: undefined, set(v) { store.set(key, v); return v; } });
  const connections = [];
  const load = loader({
    'native/settings-store': { getStringSetting: (k, d) => store.get(k) ?? d, setStringSetting: (k, v) => store.set(k, v) },
    'apps/terminal/connections': { loadConnections: () => connections.slice(), saveConnections: (c) => { connections.splice(0, connections.length, ...c); } },
    'ui/dashboard-settings': { voiceProviderSetting: set('voice.provider'), whisperServerApiKeySetting: set('voice.whisperServerApiKey'), whisperServerUrlSetting: set('voice.whisperServerUrl') },
  });
  const { addFromLink, loadServers } = load('apps/claude-code/servers');
  const r = addFromLink('evencc://add?url=http%3A%2F%2F192.168.1.85%3A3456&token=tok&name=mule&stt=1&terminal=g2mirror%3A%2F%2Ftok%40192.168.1.85');
  assert.equal(r.server.name, 'mule');
  assert.equal(JSON.stringify(loadServers()), JSON.stringify([{ name: 'mule', url: 'http://192.168.1.85:3456', token: 'tok' }]));
  assert.equal(store.get('voice.provider'), 'whisper-server');
  assert.equal(store.get('voice.whisperServerUrl'), 'http://192.168.1.85:3456/api/stt/v1');
  assert.equal(store.get('voice.whisperServerApiKey'), 'tok');
  assert.equal(connections.length, 1);
  assert.equal(connections[0].url, 'g2mirror://tok@192.168.1.85');
  // scanning again updates rather than duplicates
  addFromLink('evencc://add?url=http%3A%2F%2F192.168.1.85%3A3456&token=new&name=mule&terminal=g2mirror%3A%2F%2Fnew%40192.168.1.85');
  assert.equal(loadServers().length, 1);
  assert.equal(loadServers()[0].token, 'new');
  assert.equal(connections.length, 1);
  assert.equal(addFromLink('evencc://add?url=ftp%3A%2F%2Fx&token=t'), null);
  // even-cc's QR code itself, scanned in Faceclaw
  const r2 = addFromLink('http://192.168.1.85:3457/setup?name=mule+%28WSL%29&token=wsl');
  assert.equal(r2.server.url, 'http://192.168.1.85:3457');
  assert.equal(r2.server.name, 'mule (WSL)');
  assert.equal(loadServers().length, 2);
  assert.equal(addFromLink('https://example.com/other?token=x'), null);
});
