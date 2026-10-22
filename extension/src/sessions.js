// Agent sessions written by hook.js, and the state each light should show.
// Pure functions apart from reading the sessions folder, so they can be tested without VS Code.
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATES = ['error', 'attention', 'working', 'done', 'idle'];
const DEFAULT_PRIORITY = STATES;
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Session files: <agent>--<session>.json with { agent, state, event, cwd, ts }
function readSessions(dir, now = Date.now()) {
    const sessions = [];
    let files = [];
    try { files = fs.readdirSync(dir); } catch (e) { return sessions; }
    for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const file = path.join(dir, f);
        try {
            const s = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (now - s.ts > SESSION_MAX_AGE_MS) {
                fs.rmSync(file, { force: true });
                continue;
            }
            sessions.push({ ...s, id: f.slice(0, -5) });
        } catch (e) { /* the file is being written */ }
    }
    return sessions;
}

// Pressing Esc fires no hook, but Claude Code ends the transcript with "[Request interrupted by user...]"
function interrupted(s) {
    if (!s.transcript) return false;
    try {
        const fd = fs.openSync(s.transcript, 'r');
        try {
            const size = fs.fstatSync(fd).size;
            const len = Math.min(size, 4096);
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, size - len);
            const last = buf.toString('utf8').split('\n').filter((l) => l.trim()).pop() || '';
            return last.includes('[Request interrupted by user');
        } finally {
            fs.closeSync(fd);
        }
    } catch (e) {
        return false;
    }
}

// Interrupted turns send no "done": the transcript tells, and a very long silent "working" counts as done anyway
function effectiveState(s, now, opts) {
    const staleMs = (opts.staleWorkingMinutes || 0) * 60000;
    const doneMs = (opts.doneToIdleMinutes || 0) * 60000;
    let state = s.state;
    if (state === 'working' && interrupted(s)) state = 'done';
    if (state === 'working' && staleMs > 0 && now - s.ts > staleMs) state = 'done';
    if (state === 'done' && doneMs > 0 && now - s.ts > doneMs) state = 'idle';
    return STATES.includes(state) ? state : 'idle';
}

// The most important state wins; priority lists states from most to least important
function aggregate(sessions, priority = DEFAULT_PRIORITY) {
    const order = [...priority.filter((s) => STATES.includes(s)), ...STATES.filter((s) => !priority.includes(s))];
    let best = 'idle';
    for (const s of sessions) {
        if (order.indexOf(s.effective) < order.indexOf(best)) best = s.effective;
    }
    return best;
}

const expandHome = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());
const norm = (p) => expandHome(p).replace(/\\/g, '/').replace(/\/+$/, '');

// A project pattern is a folder path (~ allowed, matches the folder and everything below it),
// a path with * / ** wildcards, or a bare folder name that matches any path component.
function matchesProject(cwd, pattern) {
    if (!cwd || !pattern) return false;
    const dir = norm(cwd);
    const p = norm(pattern.trim());
    if (!p.includes('/')) {
        const re = globToRegex(p);
        return dir.split('/').some((part) => re.test(part));
    }
    const re = new RegExp(`^${globSource(p)}(/.*)?$`, process.platform === 'win32' ? 'i' : '');
    return re.test(dir);
}

function globSource(glob) {
    return glob.split(/(\*\*|\*)/).map((part) => {
        if (part === '**') return '.*';
        if (part === '*') return '[^/]*';
        return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
}

const globToRegex = (glob) => new RegExp(`^${globSource(glob)}$`, 'i');

// Sessions a light shows: its agents (all if empty) and projects (all if empty), minus muted sessions
function sessionsForLight(sessions, light, muted = new Set()) {
    const agents = light.agents || [];
    const projects = light.projects || [];
    return sessions.filter((s) =>
        !muted.has(s.id) &&
        (!agents.length || agents.includes(s.agent)) &&
        (!projects.length || projects.some((p) => matchesProject(s.cwd, p))));
}

module.exports = { interrupted, STATES, DEFAULT_PRIORITY, readSessions, effectiveState, aggregate, matchesProject, sessionsForLight };
