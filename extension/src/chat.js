// Prompts typed on the light's page (Chat tab): picked up here, run with the claude CLI, answered on the page.
// Only needs fs, child_process and lights.js, so it can be tested without VS Code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const lights = require('./lights');

const MAX_PROJECTS = 8;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const PROJECTS_REFRESH_MS = 20000; // the light forgets its project list when it restarts

const base = (p) => path.basename(p) || p;

// Short unique names for project folders: the folder name, with its parent folder when two share a name
function projectList(paths) {
    const unique = [...new Set(paths.filter(Boolean))].slice(0, MAX_PROJECTS);
    const count = {};
    for (const p of unique) count[base(p)] = (count[base(p)] || 0) + 1;
    return unique.map((p) => ({
        path: p,
        name: (count[base(p)] > 1 ? `${base(path.dirname(p))}/${base(p)}` : base(p)).slice(0, 40),
    }));
}

// The Claude Code extension for VS Code ships its own binary, which is usually not on the PATH
function findClaude(setting, home = os.homedir()) {
    if (setting) return setting;
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    try {
        const dir = path.join(home, '.vscode', 'extensions');
        const found = fs.readdirSync(dir).filter((d) => d.startsWith('anthropic.claude-code-'))
            .map((d) => path.join(dir, d, 'resources', 'native-binary', exe))
            .filter((f) => fs.existsSync(f))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (found.length) return found[found.length - 1];
    } catch (e) { /* no VS Code extension folder */ }
    return 'claude';
}

// `claude -p --output-format json` prints one result object (or a list of events that ends with it)
function parseResult(stdout) {
    let data;
    try { data = JSON.parse(stdout); } catch (e) { return null; }
    if (Array.isArray(data)) data = data.filter((x) => x && x.type === 'result').pop();
    if (!data || typeof data !== 'object') return null;
    return { text: String(data.result || ''), sessionId: data.session_id || null, isError: !!data.is_error };
}

// Arguments for an interactive claude in a terminal. The prompt is one argument (no shell), and "--" keeps a prompt that
// starts with "-" from being taken as an option.
const terminalArgs = ({ text, continueChat }) => [...(continueChat ? ['--continue'] : []), '--', text];

// Typed into a running claude as a paste (so line breaks stay in the prompt), then Enter
const pasted = (text) => `\x1b[200~${text}\x1b[201~`;

// CODESHELF_CHAT_RUN tells hook.js not to post this run to the history again: the answer is posted from here
function runClaude({ claude, cwd, text, resume }, timeoutMs = RUN_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const args = ['-p', '--output-format', 'json'];
        if (resume) args.push('--resume', resume);
        const child = spawn(claude, args, {
            cwd,
            env: { ...process.env, CODESHELF_CHAT_RUN: '1' },
            shell: process.platform === 'win32',
            windowsHide: true,
        });
        let out = '';
        let err = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error('timed out'));
        }, timeoutMs);
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        child.on('error', (e) => {
            clearTimeout(timer);
            reject(e.code === 'ENOENT' ? new Error(`"${claude}" not found, set codeshelfLight.claudePath`) : e);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            const result = parseResult(out);
            if (result) resolve(result);
            else reject(new Error((err.trim() || `claude exited with ${code}`).slice(-300)));
        });
        child.stdin.on('error', () => { /* the process ended before reading the prompt */ });
        child.stdin.end(text);
    });
}

// Polls the lights for prompts and runs them one at a time
class Bridge {
    constructor(log, run = runClaude) {
        this.log = log;
        this.run = run;
        this.busy = false;
        this.sessions = new Map(); // "<light>|<folder>" -> session id, so a chat continues
        this.started = new Set(); // keys that already had a prompt: the next one continues that conversation
        this.published = new Map(); // light -> { key, at } of the last project list sent
        this.failing = new Set();
    }

    async poll(lightList, projects, claude) {
        if (this.busy) return;
        this.busy = true;
        try {
            for (const light of lightList) {
                try {
                    await this.pollLight(light, projects, claude);
                    if (this.failing.delete(light.host)) this.log(`${light.name}: chat is back`);
                } catch (e) {
                    if (!this.failing.has(light.host)) this.log(`${light.name}: chat unavailable (${e.message})`);
                    this.failing.add(light.host);
                }
            }
        } finally {
            this.busy = false;
        }
    }

    async pollLight(light, projects, claude) {
        const names = projects.map((p) => p.name);
        const key = JSON.stringify(names);
        const last = this.published.get(light.host);
        if (!last || last.key !== key || Date.now() - last.at > PROJECTS_REFRESH_MS) {
            await lights.request(light, 'POST', '/chat/projects', JSON.stringify({ projects: names }));
            this.published.set(light.host, { key, at: Date.now() });
        }
        const job = JSON.parse(await lights.request(light, 'POST', '/chat/next', '{}'));
        if (job.id) await this.runJob(light, job, projects, claude);
    }

    async runJob(light, job, projects, claude) {
        const post = (role, text) => lights.request(light, 'POST', '/chat/msg', JSON.stringify({ role, project: job.project, text }));
        try {
            const project = projects.find((p) => p.name === job.project);
            if (!project) throw new Error(`unknown project "${job.project}"`);
            const key = `${light.host}|${project.path}`;
            if (job.newChat) {
                this.sessions.delete(key);
                this.started.delete(key);
            }
            this.log(`${light.name}: prompt for ${project.name}`);
            const result = await this.run({
                claude, cwd: project.path, text: job.text, resume: this.sessions.get(key),
                continueChat: this.started.has(key), fresh: !!job.newChat,
            });
            this.started.add(key);
            if (result.sessionId) this.sessions.set(key, result.sessionId);
            // A run that only started (terminal) answers through the hooks; the runner may leave a note
            if (result.started) {
                if (result.note) await post('note', result.note);
            } else {
                await post(result.isError ? 'note' : 'assistant', result.text || '(no answer)');
            }
        } catch (e) {
            this.log(`${light.name}: prompt failed: ${e.message}`);
            await post('note', `Failed: ${e.message}`).catch(() => { /* the light is gone */ });
        }
        await lights.request(light, 'POST', '/chat/done', JSON.stringify({ id: job.id })).catch(() => { /* it frees itself */ });
    }
}

module.exports = { projectList, findClaude, parseResult, terminalArgs, pasted, runClaude, Bridge };
