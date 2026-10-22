// hook.js asking a fake light (permission requests and AskUserQuestion), against a temporary home folder
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-ask-'));
const base = path.join(home, '.codeshelf', 'light');
const hook = path.join(__dirname, '..', 'src', 'hook.js');
fs.mkdirSync(base, { recursive: true });
fs.writeFileSync(path.join(base, 'agents.json'), JSON.stringify({
    'claude-code': { events: { PermissionRequest: 'attention' }, ask: { PermissionRequest: 'permission', 'ask-question': 'question' } },
}));

// A light that answers every question with reply(question), or never when reply returns undefined
let reply = () => undefined;
const seen = [];
let current = { id: 0 };
let last = 0;
const light = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (req.headers.authorization !== 'Basic ' + Buffer.from('admin:pw').toString('base64')) return send(401, {});
        if (req.method === 'POST' && req.url === '/ask') {
            current = { id: ++last, ...JSON.parse(body) };
            seen.push(current);
            return send(200, { id: current.id });
        }
        if (req.method === 'GET' && req.url === '/ask') {
            const a = current.id ? reply(current) : undefined;
            return send(200, a === undefined ? current : { ...current, answer: a });
        }
        if (req.url === '/ask/clear') { current = { id: 0 }; return send(200, {}); }
        send(404, {});
    });
});

function writeLights(over = {}) {
    fs.writeFileSync(path.join(base, 'lights.json'), JSON.stringify({
        ask: { enabled: true, timeout: 5 },
        lights: [{ name: 'L', host: `127.0.0.1:${light.address().port}`, password: 'pw', agents: [] }],
        ...over,
    }));
}

function run(event, payload) {
    const { CODESHELF_CHAT_RUN, ...inherited } = process.env; // set when this suite runs inside a prompt from the light
    return new Promise((resolve) => {
        const child = execFile('node', [hook, 'claude-code', event], { env: { ...inherited, HOME: home, USERPROFILE: home } },
            (err, stdout) => resolve(stdout));
        child.stdin.end(JSON.stringify({ session_id: 's1', cwd: '/work/proj', ...payload }));
    });
}

test.before(() => new Promise((ok) => light.listen(0, '127.0.0.1', ok)));
test.after(() => { light.close(); fs.rmSync(home, { recursive: true, force: true }); });

test('a permission request is answered from the light', async () => {
    writeLights();
    reply = () => 'Allow';
    const out = JSON.parse(await run('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } }));
    assert.deepStrictEqual(out.hookSpecificOutput, { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } });
    assert.strictEqual(seen.at(-1).title, 'Allow Bash?');
    assert.match(seen.at(-1).text, /npm test/);
    assert.deepStrictEqual(seen.at(-1).options, ['Allow', 'Deny']);
    reply = () => 'Deny';
    const denied = JSON.parse(await run('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }));
    assert.strictEqual(denied.hookSpecificOutput.decision.behavior, 'deny');
    assert.strictEqual(current.id, 0, 'the question is cleared afterwards');
});

test('AskUserQuestion gets the answers as updatedInput', async () => {
    writeLights();
    reply = (q) => (q.options.includes('Blue') ? 'Blue' : 'my own text');
    const input = { questions: [
        { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Blue', description: 'calm' }, { label: 'Red' }] },
        { question: 'Which name?', header: 'Name', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
    ] };
    const out = JSON.parse(await run('ask-question', { tool_name: 'AskUserQuestion', tool_input: input }));
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'allow');
    assert.deepStrictEqual(out.hookSpecificOutput.updatedInput.answers, { 'Which color?': 'Blue', 'Which name?': 'my own text' });
    assert.deepStrictEqual(out.hookSpecificOutput.updatedInput.questions, input.questions);
    assert.strictEqual(seen.at(-1).free, true);
});

test('nothing is printed when the feature is off, the password is wrong, or multi-select', async () => {
    reply = () => 'Allow';
    writeLights({ ask: { enabled: false, timeout: 5 } });
    assert.strictEqual(await run('PermissionRequest', { tool_name: 'Bash', tool_input: {} }), '');
    writeLights({ lights: [{ host: `127.0.0.1:${light.address().port}`, password: 'wrong' }] });
    assert.strictEqual(await run('PermissionRequest', { tool_name: 'Bash', tool_input: {} }), '');
    writeLights({ lights: [{ host: `127.0.0.1:${light.address().port}` }] }); // no password: never used
    assert.strictEqual(await run('PermissionRequest', { tool_name: 'Bash', tool_input: {} }), '');
    writeLights();
    const multi = { questions: [{ question: 'Pick', multiSelect: true, options: [{ label: 'A' }] }] };
    assert.strictEqual(await run('ask-question', { tool_name: 'AskUserQuestion', tool_input: multi }), '');
});

test('without an answer in time the agent asks in the terminal', async () => {
    writeLights();
    reply = () => undefined;
    const t0 = Date.now();
    assert.strictEqual(await run('PermissionRequest', { tool_name: 'Bash', tool_input: {} }), '');
    assert.ok(Date.now() - t0 >= 4500);
    assert.strictEqual(current.id, 0);
});
