// Chat tab: project list, claude lookup and output, the Bridge against a fake light, and hook.js posting the history
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const chat = require('../src/chat');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-chat-'));
const servers = [];
test.after(() => {
    for (const s of servers) { s.close(); s.closeAllConnections(); }
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('projectList dedupes, names folders and tells equal names apart', () => {
    const list = chat.projectList(['/a/app', '/b/app', '/a/app', '/c/tool', '']);
    assert.deepStrictEqual(list.map((p) => p.name), ['a/app', 'b/app', 'tool']);
    assert.deepStrictEqual(list.map((p) => p.path), ['/a/app', '/b/app', '/c/tool']);
    assert.strictEqual(chat.projectList(Array.from({ length: 12 }, (_, i) => `/p/${i}`)).length, 8);
});

test('findClaude takes the setting, then the newest VS Code extension binary', () => {
    assert.strictEqual(chat.findClaude('/x/claude'), '/x/claude');
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    for (const v of ['2.1.9', '2.1.10']) {
        const dir = path.join(tmp, '.vscode', 'extensions', `anthropic.claude-code-${v}-linux-x64`, 'resources', 'native-binary');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, exe), '');
    }
    assert.match(chat.findClaude('', tmp), /claude-code-2\.1\.10-/);
    assert.strictEqual(chat.findClaude('', path.join(tmp, 'nothing')), 'claude');
});

test('parseResult reads one result or the last result of a list', () => {
    assert.deepStrictEqual(chat.parseResult('{"type":"result","result":"hi","session_id":"s","is_error":false}'), { text: 'hi', sessionId: 's', isError: false });
    assert.strictEqual(chat.parseResult('[{"type":"system"},{"type":"result","result":"x","is_error":true}]').isError, true);
    assert.strictEqual(chat.parseResult('not json'), null);
});

// A light with the chat endpoints, kept in memory
function fakeLight() {
    const state = { projects: null, queue: [], msgs: [], done: [], calls: 0 };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const send = (obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.headers.authorization !== 'Basic ' + Buffer.from('admin:pw').toString('base64')) { res.writeHead(401); return res.end(); }
            state.calls++;
            const data = body ? JSON.parse(body) : {};
            if (req.url === '/chat/projects') { state.projects = data.projects; return send({}); }
            if (req.url === '/chat/next') return send(state.queue.shift() || { id: 0 });
            if (req.url === '/chat/msg') { state.msgs.push(data); return send({ id: state.msgs.length }); }
            if (req.url === '/chat/done') { state.done.push(data.id); return send({}); }
            res.writeHead(404);
            res.end();
        });
    });
    servers.push(server);
    return { server, state };
}

test('the Bridge publishes projects, runs a prompt and posts the answer', async () => {
    const { server, state } = fakeLight();
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const light = { name: 'L', host: `127.0.0.1:${server.address().port}`, password: 'pw' };
    const runs = [];
    const bridge = new chat.Bridge(() => {}, async (opts) => {
        runs.push(opts);
        if (opts.text === 'boom') throw new Error('nope');
        return { text: `echo ${opts.text}`, sessionId: 'sess-1', isError: false };
    });
    const projects = [{ name: 'app', path: tmp }];

    await bridge.poll([light], projects, 'claude');
    assert.deepStrictEqual(state.projects, ['app']);
    assert.strictEqual(runs.length, 0);

    state.queue.push({ id: 1, project: 'app', text: 'hello', newChat: false });
    await bridge.poll([light], projects, 'claude');
    assert.deepStrictEqual(runs[0], { claude: 'claude', cwd: tmp, text: 'hello', resume: undefined, continueChat: false, fresh: false });
    assert.deepStrictEqual(state.msgs.at(-1), { role: 'assistant', project: 'app', text: 'echo hello' });
    assert.deepStrictEqual(state.done, [1]);

    state.queue.push({ id: 2, project: 'app', text: 'again', newChat: false });
    await bridge.poll([light], projects, 'claude');
    assert.strictEqual(runs[1].resume, 'sess-1', 'the conversation continues');
    assert.strictEqual(runs[1].continueChat, true);

    state.queue.push({ id: 3, project: 'app', text: 'fresh', newChat: true });
    await bridge.poll([light], projects, 'claude');
    assert.strictEqual(runs[2].resume, undefined, 'new chat starts over');
    assert.deepStrictEqual([runs[2].continueChat, runs[2].fresh], [false, true]);

    state.queue.push({ id: 4, project: 'app', text: 'boom', newChat: false });
    await bridge.poll([light], projects, 'claude');
    assert.deepStrictEqual(state.msgs.at(-1), { role: 'note', project: 'app', text: 'Failed: nope' });

    state.queue.push({ id: 5, project: 'gone', text: 'x', newChat: false });
    await bridge.poll([light], projects, 'claude');
    assert.match(state.msgs.at(-1).text, /unknown project/);
    assert.deepStrictEqual(state.done, [1, 2, 3, 4, 5], 'every prompt is released');
});

test('terminal prompts: the answer is left to the hooks, a note only when asked for', async () => {
    const { server, state } = fakeLight();
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const light = { name: 'L', host: `127.0.0.1:${server.address().port}`, password: 'pw' };
    let note = '';
    const bridge = new chat.Bridge(() => {}, async () => ({ started: true, note }));
    const projects = [{ name: 'app', path: tmp }];
    state.queue.push({ id: 1, project: 'app', text: 'go', newChat: false });
    await bridge.poll([light], projects, 'claude');
    assert.strictEqual(state.msgs.length, 0, 'no answer is posted from here');
    assert.deepStrictEqual(state.done, [1], 'the prompt is released right away');
    note = 'Turn on chatHistory';
    state.queue.push({ id: 2, project: 'app', text: 'go again', newChat: false });
    await bridge.poll([light], projects, 'claude');
    assert.deepStrictEqual(state.msgs, [{ role: 'note', project: 'app', text: 'Turn on chatHistory' }]);
});

test('terminalArgs keep the prompt out of the options', () => {
    assert.deepStrictEqual(chat.terminalArgs({ text: '--dangerously-skip-permissions', continueChat: false }), ['--', '--dangerously-skip-permissions']);
    assert.deepStrictEqual(chat.terminalArgs({ text: 'hi', continueChat: true }), ['--continue', '--', 'hi']);
    assert.strictEqual(chat.pasted('a\nb'), '\x1b[200~a\nb\x1b[201~');
});

test('runClaude passes the prompt on stdin and the chat marker in the environment', { skip: process.platform === 'win32' }, async () => {
    const fake = path.join(tmp, 'fake-claude');
    fs.writeFileSync(fake, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', result: input + '|' + process.argv.slice(2).join(' ') + '|' + process.env.CODESHELF_CHAT_RUN, session_id: 'abc', is_error: false })));
`, { mode: 0o755 });
    const r = await chat.runClaude({ claude: fake, cwd: tmp, text: 'question', resume: 'old' });
    assert.deepStrictEqual(r, { text: 'question|-p --output-format json --resume old|1', sessionId: 'abc', isError: false });
    await assert.rejects(chat.runClaude({ claude: path.join(tmp, 'missing'), cwd: tmp, text: 'x' }), /not found/);
});

// ---- hook.js posting the history
const home = path.join(tmp, 'home');
const base = path.join(home, '.codeshelf', 'light');
const hook = path.join(__dirname, '..', 'src', 'hook.js');
fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, 'agents.json'), JSON.stringify({
    'claude-code': { events: { Stop: 'done', UserPromptSubmit: 'working' }, chat: { UserPromptSubmit: 'user', Stop: 'assistant' } },
}));

function runHook(event, payload, env = {}) {
    const { CODESHELF_CHAT_RUN, ...inherited } = process.env; // set when this suite runs inside a prompt from the light
    return new Promise((resolve) => {
        const child = execFile('node', [hook, 'claude-code', event], { env: { ...inherited, HOME: home, USERPROFILE: home, ...env } }, (err, stdout) => resolve(stdout));
        child.stdin.end(JSON.stringify({ session_id: 's1', cwd: '/work/proj', ...payload }));
    });
}

test('hook.js posts prompts and answers to the history, only when switched on', async () => {
    const { server, state } = fakeLight();
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const writeLights = (history, host = `127.0.0.1:${server.address().port}`) => fs.writeFileSync(path.join(base, 'lights.json'),
        JSON.stringify({ ask: { enabled: false }, chat: { history }, lights: [{ name: 'L', host, password: 'pw', agents: [] }] }));
    const transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(transcript, [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'earlier' }] } },
        { type: 'user', message: { content: 'q' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }, { type: 'text', text: 'from transcript' }] } },
    ].map((e) => JSON.stringify(e)).join('\n'));

    writeLights(false);
    await runHook('UserPromptSubmit', { prompt: 'hi' });
    assert.strictEqual(state.msgs.length, 0, 'off by default');

    writeLights(true);
    await runHook('UserPromptSubmit', { prompt: 'hi there' });
    assert.deepStrictEqual(state.msgs.at(-1), { role: 'user', project: 'proj', text: 'hi there' });
    await runHook('Stop', { last_assistant_message: 'All done.' });
    assert.deepStrictEqual(state.msgs.at(-1), { role: 'assistant', project: 'proj', text: 'All done.' });
    await runHook('Stop', { transcript_path: transcript });
    assert.strictEqual(state.msgs.at(-1).text, 'from transcript');

    const before = state.msgs.length;
    await runHook('Stop', { last_assistant_message: 'from the light itself' }, { CODESHELF_CHAT_RUN: '1' });
    assert.strictEqual(state.msgs.length, before, 'runs started from the light are not posted twice');

    // A light that is off must not slow every hook down
    writeLights(true, '127.0.0.1:1');
    await runHook('Stop', { last_assistant_message: 'x' });
    const t0 = Date.now();
    await runHook('Stop', { last_assistant_message: 'x' });
    assert.ok(fs.existsSync(path.join(base, 'chat-down')));
    assert.ok(Date.now() - t0 < 1000);
});
