#!/usr/bin/env node
// CodeShelf Light hook, shared by all agents.
//   node hook.js <agent> <event>        maps the event with the rules from agents.json
//   node hook.js <agent> working        a state directly (working|attention|error|done|idle|end)
// Reads JSON from stdin (if the agent sends it) and writes the session state to ~/.codeshelf/light/sessions/.
// Prints to stdout only what the agent expects (e.g. "{}" for Gemini), never any other text.
const fs = require('fs');
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

let finished = false;
function finish(raw) {
    if (finished) return;
    finished = true;
    const agent = loadAgent();
    let payload = {};
    try { payload = JSON.parse(raw) || {}; } catch (e) { /* the agent sent no JSON */ }
    try { handle(agent, payload); } catch (e) { /* the hook must never break the agent */ }
    const stdout = agent.stdout || {};
    const out = stdout[event] !== undefined ? stdout[event] : (stdout.default || '');
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
