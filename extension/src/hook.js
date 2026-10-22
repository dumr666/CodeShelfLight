#!/usr/bin/env node
// CodeShelf Light hook, shared by all agents.
//   node hook.js <agent> <event>        maps the event with the rules from agents.json
//   node hook.js <agent> working        a state directly (working|attention|error|done|idle|end)
// Reads JSON from stdin (if the agent sends it) and writes the session state to ~/.codeshelf/light/sessions/.
// Prints to stdout only what the agent expects (e.g. "{}" for Gemini), never any other text.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const BASE = path.join(os.homedir(), '.codeshelf', 'light');
const SESSIONS = path.join(BASE, 'sessions');
const STATES = ['working', 'attention', 'error', 'done', 'idle', 'end'];
const [agentId = 'custom', event = ''] = process.argv.slice(2);

function loadAgent() {
    try {
        return JSON.parse(fs.readFileSync(path.join(BASE, 'agents.json'), 'utf8'))[agentId] || {};
    } catch (e) {
        return {};
    }
}

// A rule is a state name or { by: "field", cases: { value: state }, default: state }
function resolve(rule, payload) {
    if (typeof rule === 'string') return rule;
    if (rule && typeof rule === 'object') {
        const value = String(payload[rule.by]);
        if (rule.cases && rule.cases[value] !== undefined) return rule.cases[value];
        return rule.default || null;
    }
    return null;
}

function handle(agent, payload) {
    let rule = (agent.events || {})[event];
    if (rule === undefined && STATES.includes(event)) rule = event;
    if (rule === undefined && (agent.ask || {})[event]) rule = 'attention';
    const state = resolve(rule, payload);
    if (!STATES.includes(state)) return;
    const session = payload.session_id || payload.sessionId || payload.conversation_id || process.env.GEMINI_SESSION_ID || 'default';
    const file = path.join(SESSIONS, `${agentId}--${String(session).replace(/[^\w.-]/g, '_')}.json`);
    if (state === 'end') {
        fs.rmSync(file, { force: true });
        return;
    }
    fs.mkdirSync(SESSIONS, { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
        agent: agentId,
        state,
        event,
        cwd: payload.cwd || (payload.workspace_roots || [])[0] || process.cwd(),
        ts: Date.now(),
    }));
    fs.renameSync(tmp, file);
}


// ---- Questions on the light (Claude Code): permission requests and AskUserQuestion.
// With codeshelfLight.remoteAnswers on, the question is posted to the light's web page and this hook waits for the answer.
// Without an answer in time, or if anything fails, it prints nothing and the agent asks in the terminal as usual.
// ~/.codeshelf/light/lights.json, written by the extension: the lights this agent may talk to and what is switched on
function readLights() {
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(BASE, 'lights.json'), 'utf8'));
        const lights = (cfg.lights || []).filter((l) => l.host && l.password && (!(l.agents || []).length || l.agents.includes(agentId)));
        return { cfg, lights };
    } catch (e) {
        return { cfg: {}, lights: [] };
    }
}

function loadAsk(agent) {
    const kind = (agent.ask || {})[event];
    if (!kind) return null;
    const { cfg, lights } = readLights();
    if (!cfg.ask || !cfg.ask.enabled) return null;
    return lights.length ? { kind, timeout: Math.min(90, Math.max(5, +cfg.ask.timeout || 60)) * 1000, lights } : null;
}

function call(light, method, urlPath, body, timeout = 3000) {
    const [hostname, port] = light.host.replace(/^https?:\/\//, '').replace(/\/+$/, '').split(':');
    const headers = { Authorization: 'Basic ' + Buffer.from(`admin:${light.password}`).toString('base64') };
    if (body) headers['Content-Type'] = 'application/json';
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname, port: port || 80, path: urlPath, method, timeout, headers }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(data || '{}')) : reject(new Error(`HTTP ${res.statusCode}`))));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
    });
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const clip = (v, n) => String(v === undefined ? '' : v).slice(0, n);

// Posts a question to the first light that takes it and returns the answer, or null
async function askLights(ask, q, deadline) {
    const ttl = Math.max(5, Math.floor((deadline - Date.now()) / 1000));
    let light = null;
    let id = 0;
    for (const l of ask.lights) {
        try {
            id = (await call(l, 'POST', '/ask', { ...q, ttl })).id;
            light = l;
            break;
        } catch (e) { /* try the next light */ }
    }
    if (!light) return null;
    let answer = null;
    while (Date.now() < deadline) {
        await sleep(1000);
        let cur;
        try { cur = await call(light, 'GET', '/ask'); } catch (e) { continue; }
        if (cur.id !== id) break; // expired or replaced by another question
        if (cur.answer !== undefined) {
            answer = cur.answer;
            break;
        }
    }
    try { await call(light, 'POST', '/ask/clear', {}); } catch (e) { /* it expires on its own */ }
    return answer;
}

// ---- Chat history on the light (Claude Code): what you ask and what the agent answers.
// Runs started from the light's own Chat tab are skipped (CODESHELF_CHAT_RUN): the extension posts those answers itself.
const CHAT_TEXT = 2500;
const DOWN_FILE = path.join(BASE, 'chat-down'); // touched when a light did not answer, so a light that is off costs nothing for a while
const DOWN_MS = 60000;

// The last thing the agent said: newer Claude Code versions send it, otherwise it is read from the end of the transcript
function lastAssistantText(payload) {
    if (typeof payload.last_assistant_message === 'string' && payload.last_assistant_message.trim()) return payload.last_assistant_message.trim();
    try {
        const size = fs.statSync(payload.transcript_path).size;
        const len = Math.min(size, 256 * 1024);
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(payload.transcript_path, 'r');
        fs.readSync(fd, buf, 0, len, size - len);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            let entry;
            try { entry = JSON.parse(lines[i]); } catch (e) { continue; }
            if (entry.type !== 'assistant' || !entry.message) continue;
            const blocks = Array.isArray(entry.message.content) ? entry.message.content : [];
            const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
            if (text) return text;
        }
    } catch (e) { /* no transcript */ }
    return '';
}

async function postChat(agent, payload) {
    const kind = (agent.chat || {})[event];
    if (!kind || process.env.CODESHELF_CHAT_RUN) return;
    const { cfg, lights } = readLights();
    if (!cfg.chat || !cfg.chat.history || !lights.length) return;
    try {
        if (Date.now() - fs.statSync(DOWN_FILE).mtimeMs < DOWN_MS) return;
    } catch (e) { /* not down */ }
    const text = kind === 'user' ? String(payload.prompt || '').trim() : lastAssistantText(payload);
    if (!text) return;
    const body = { role: kind === 'user' ? 'user' : 'assistant', project: path.basename(payload.cwd || ''), text: clip(text, CHAT_TEXT) };
    for (const light of lights) {
        try {
            await call(light, 'POST', '/chat/msg', body, 1500);
        } catch (e) {
            try { fs.writeFileSync(DOWN_FILE, String(Date.now())); } catch (err) { /* nothing to do */ }
        }
    }
}

function describeTool(name, input) {
    const i = input || {};
    const detail = i.command || i.file_path || i.path || i.url || i.pattern || (Object.keys(i).length ? JSON.stringify(i) : '');
    return { title: clip(`Allow ${name}?`, 80), text: clip(detail, 400) };
}

async function answerQuestions(ask, payload) {
    const project = path.basename(payload.cwd || '');
    const deadline = Date.now() + ask.timeout;
    if (ask.kind === 'permission') {
        const d = describeTool(payload.tool_name || 'tool', payload.tool_input);
        const answer = await askLights(ask, { title: d.title, text: (project ? `${project}\n` : '') + d.text, options: ['Allow', 'Deny'] }, deadline);
        if (answer === 'Allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
        if (answer === 'Deny') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from CodeShelf Light' } } };
        return null;
    }
    // AskUserQuestion: the tool takes the answers as { "<question>": "<chosen label or text>" }
    const input = payload.tool_input || {};
    const questions = Array.isArray(input.questions) ? input.questions : [];
    if (payload.tool_name !== 'AskUserQuestion' || !questions.length || questions.some((q) => q.multiSelect)) return null;
    const answers = {};
    for (const q of questions) {
        const options = (q.options || []).map((o) => clip(o.label, 60)).slice(0, 6);
        const text = [project, q.question, ...(q.options || []).map((o) => o.description ? `${o.label}: ${o.description}` : '')].filter(Boolean).join('\n');
        const answer = await askLights(ask, { title: clip(q.header || 'Question', 80), text: clip(text, 400), options, free: true }, deadline);
        if (answer === null) return null;
        answers[q.question] = answer;
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, answers } } };
}

let finished = false;
async function finish(raw) {
    if (finished) return;
    finished = true;
    const agent = loadAgent();
    let payload = {};
    try { payload = JSON.parse(raw) || {}; } catch (e) { /* the agent sent no JSON */ }
    try { handle(agent, payload); } catch (e) { /* the hook must never break the agent */ }
    let out = '';
    try {
        const ask = loadAsk(agent);
        const answer = ask && await answerQuestions(ask, payload);
        if (answer) out = JSON.stringify(answer);
    } catch (e) { /* the agent asks in the terminal */ }
    try { await postChat(agent, payload); } catch (e) { /* the hook must never break the agent */ }
    if (!out) {
        const stdout = agent.stdout || {};
        out = stdout[event] !== undefined ? stdout[event] : (stdout.default || '');
    }
    if (out) process.stdout.write(out);
    process.exit(0);
}

if (process.stdin.isTTY) {
    finish('');
} else {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => finish(raw));
    setTimeout(() => finish(raw), 2000); // the agent did not close stdin
}
