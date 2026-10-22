// Agent presets and installing hooks into their settings.
// Each agent: name, format (claude | cursor | copilot), file, events { event: rule }, stdout { event|default: text }.
// A rule is a state (working | attention | error | done | idle | end) or { by, cases, default } by a field of the JSON input.
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const BASE_DIR = path.join(HOME, '.codeshelf', 'light');
const HOOK_PATH = path.join(BASE_DIR, 'hook.js');
const HOOK_MARKER = 'codeshelf/light/hook.js';
const ASK_HOOK_TIMEOUT = 100; // s; the hook gives up on its own after codeshelfLight.remoteAnswerTimeout (max 90)
const LEGACY_MARKERS = ['busy-light/hook.js']; // Claude Busy Light 0.x

const PRESETS = {
    'claude-code': {
        name: 'Claude Code',
        format: 'claude',
        file: '~/.claude/settings.json',
        detect: '~/.claude',
        matcherEvents: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'],
        // Questions the hook can send to the light (see hook.js); only does anything with codeshelfLight.remoteAnswers on
        ask: { PermissionRequest: 'permission', 'ask-question': 'question' },
        // What the hook posts to the chat history on the light; only does anything with codeshelfLight.chatHistory on
        chat: { UserPromptSubmit: 'user', Stop: 'assistant' },
        events: {
            SessionStart: { by: 'source', cases: { compact: 'working' }, default: 'idle' },
            UserPromptSubmit: 'working',
            PreToolUse: 'working',
            PostToolUse: 'working',
            PostToolUseFailure: 'working',
            SubagentStart: 'working',
            PreCompact: 'working',
            PermissionRequest: 'attention',
            Elicitation: 'attention',
            Notification: { by: 'notification_type', cases: { permission_prompt: 'attention', elicitation_dialog: 'attention', idle_prompt: 'done' } },
            Stop: 'done',
            StopFailure: 'error', // turn ended by an API error (rate limit, overloaded, auth)
            SessionEnd: 'end',
        },
    },
    'gemini-cli': {
        name: 'Gemini CLI',
        format: 'claude',
        file: '~/.gemini/settings.json',
        detect: '~/.gemini',
        timeoutMs: true,
        hookName: true,
        events: {
            SessionStart: 'idle',
            BeforeAgent: 'working',
            BeforeModel: 'working',
            BeforeTool: 'working',
            AfterTool: 'working',
            PreCompress: 'working',
            Notification: { by: 'notification_type', cases: { ToolPermission: 'attention' } },
            AfterAgent: 'done',
            SessionEnd: 'end',
        },
        stdout: { default: '{}' }, // Gemini expects JSON on stdout
    },
    'copilot-cli': {
        name: 'GitHub Copilot CLI',
        format: 'copilot',
        file: '~/.copilot/hooks/codeshelf-light.json',
        detect: '~/.copilot',
        events: {
            sessionStart: 'idle',
            userPromptSubmitted: 'working',
            preToolUse: 'working',
            postToolUse: 'working',
            postToolUseFailure: 'working',
            subagentStart: 'working',
            preCompact: 'working',
            permissionRequest: 'attention',
            notification: { by: 'notification_type', cases: { permission_prompt: 'attention', elicitation_dialog: 'attention', idle_prompt: 'done' } },
            agentStop: 'done',
            errorOccurred: { by: 'recoverable', cases: { false: 'error' } },
            sessionEnd: 'end',
        },
    },
    cursor: {
        name: 'Cursor',
        format: 'cursor',
        file: '~/.cursor/hooks.json',
        detect: '~/.cursor',
        events: {
            sessionStart: 'idle',
            beforeSubmitPrompt: 'working',
            postToolUse: 'working',
            afterShellExecution: 'working',
            afterFileEdit: 'working',
            subagentStart: 'working',
            preCompact: 'working',
            stop: { by: 'status', cases: { error: 'error' }, default: 'done' },
            sessionEnd: 'end',
        },
        stdout: { beforeSubmitPrompt: '{"continue":true}', default: '{}' },
    },
};

const expand = (p) => p.replace(/^~(?=$|\/)/, HOME);

// Presets + custom agents from the settings (same shape, id is required)
function allAgents(customAgents) {
    const agents = {};
    for (const [id, a] of Object.entries(PRESETS)) agents[id] = { ...a, id, preset: true };
    for (const a of customAgents || []) {
        if (a && a.id) agents[a.id] = { name: a.id, events: {}, ...a, preset: false };
    }
    return agents;
}

function isDetected(agent) {
    return !agent.detect || fs.existsSync(expand(agent.detect));
}

function hookCommand(nodePath, agentId, event) {
    const node = /\s/.test(nodePath) ? `"${nodePath}"` : nodePath;
    return `${node} "${HOOK_PATH}" ${agentId} ${event}`;
}

const isOurs = (cmd) => typeof cmd === 'string' && [HOOK_MARKER, ...LEGACY_MARKERS].some((m) => cmd.includes(m));

function readJson(file) {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, file + '.codeshelf.bak');
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// ---- Format "claude" (Claude Code, Gemini CLI): hooks.{Event}: [{ matcher?, hooks: [{ type, command, timeout }] }]
const claudeFormat = {
    entries(agent, nodePath) {
        const ask = agent.ask || {};
        const entries = Object.keys(agent.events).map((ev) => {
            const seconds = ask[ev] ? ASK_HOOK_TIMEOUT : 5; // a hook that waits for an answer needs time
            const hook = { type: 'command', command: hookCommand(nodePath, agent.id, ev), timeout: agent.timeoutMs ? seconds * 1000 : seconds };
            if (agent.hookName) hook.name = 'codeshelf-light';
            const group = { hooks: [hook] };
            if ((agent.matcherEvents || []).includes(ev)) group.matcher = '*';
            return [ev, group];
        });
        // AskUserQuestion has its own hook so the generic PreToolUse one stays fast
        if (ask['ask-question']) {
            entries.push(['PreToolUse', {
                matcher: 'AskUserQuestion',
                hooks: [{ type: 'command', command: hookCommand(nodePath, agent.id, 'ask-question'), timeout: ASK_HOOK_TIMEOUT }],
            }]);
        }
        return entries;
    },
    strip(settings) {
        const hooks = settings.hooks || {};
        for (const ev of Object.keys(hooks)) {
            const groups = hooks[ev].filter((g) => !(g.hooks || []).some((h) => isOurs(h.command)));
            if (groups.length) hooks[ev] = groups;
            else delete hooks[ev];
        }
        if (!Object.keys(hooks).length) delete settings.hooks;
        else settings.hooks = hooks;
    },
    install(agent, nodePath) {
        const file = expand(agent.file);
        const settings = readJson(file);
        this.strip(settings);
        settings.hooks = settings.hooks || {};
        for (const [ev, group] of this.entries(agent, nodePath)) (settings.hooks[ev] = settings.hooks[ev] || []).push(group);
        writeJson(file, settings);
    },
    uninstall(agent) {
        const file = expand(agent.file);
        if (!fs.existsSync(file)) return;
        const settings = readJson(file);
        this.strip(settings);
        writeJson(file, settings);
    },
    installed(agent, nodePath) {
        const hooks = readJson(expand(agent.file)).hooks || {};
        return this.entries(agent, nodePath).every(([ev, group]) =>
            (hooks[ev] || []).some((g) => (g.hooks || []).some((h) => h.command === group.hooks[0].command && h.timeout === group.hooks[0].timeout)));
    },
    hasAny(agent) {
        const hooks = readJson(expand(agent.file)).hooks || {};
        return Object.values(hooks).some((groups) => groups.some((g) => (g.hooks || []).some((h) => isOurs(h.command))));
    },
};

// ---- Format "cursor": { version: 1, hooks: { event: [{ command }] } }
const cursorFormat = {
    strip(settings) {
        for (const ev of Object.keys(settings.hooks || {})) {
            settings.hooks[ev] = settings.hooks[ev].filter((h) => !isOurs(h.command));
            if (!settings.hooks[ev].length) delete settings.hooks[ev];
        }
    },
    install(agent, nodePath) {
        const file = expand(agent.file);
        const settings = { version: 1, hooks: {}, ...readJson(file) };
        this.strip(settings);
        for (const ev of Object.keys(agent.events)) (settings.hooks[ev] = settings.hooks[ev] || []).push({ command: hookCommand(nodePath, agent.id, ev) });
        writeJson(file, settings);
    },
    uninstall(agent) {
        const file = expand(agent.file);
        if (!fs.existsSync(file)) return;
        const settings = readJson(file);
        this.strip(settings);
        writeJson(file, settings);
    },
    installed(agent, nodePath) {
        const hooks = readJson(expand(agent.file)).hooks || {};
        return Object.keys(agent.events).every((ev) => (hooks[ev] || []).some((h) => h.command === hookCommand(nodePath, agent.id, ev)));
    },
    hasAny(agent) {
        return Object.values(readJson(expand(agent.file)).hooks || {}).some((list) => list.some((h) => isOurs(h.command)));
    },
};

// ---- Format "copilot": its own file in ~/.copilot/hooks/, { version: 1, hooks: { event: [{ type, bash, powershell, timeoutSec }] } }
const copilotFormat = {
    build(agent, nodePath) {
        const hooks = {};
        for (const ev of Object.keys(agent.events)) {
            const cmd = hookCommand(nodePath, agent.id, ev);
            hooks[ev] = [{ type: 'command', bash: cmd, powershell: cmd, timeoutSec: 5 }];
        }
        return { version: 1, hooks };
    },
    install(agent, nodePath) {
        writeJson(expand(agent.file), this.build(agent, nodePath));
    },
    uninstall(agent) {
        fs.rmSync(expand(agent.file), { force: true });
    },
    installed(agent, nodePath) {
        return JSON.stringify(readJson(expand(agent.file))) === JSON.stringify(this.build(agent, nodePath));
    },
    hasAny(agent) {
        return fs.existsSync(expand(agent.file));
    },
};

const FORMATS = { claude: claudeFormat, cursor: cursorFormat, copilot: copilotFormat };

// Custom agents without format/file are not installed: add the hook command yourself ("Copy Hook Command")
function canInstall(agent) {
    return !!(agent.file && FORMATS[agent.format]);
}

function install(agent, nodePath) {
    FORMATS[agent.format].install(agent, nodePath);
}

function uninstall(agent) {
    if (canInstall(agent)) FORMATS[agent.format].uninstall(agent);
}

function isInstalled(agent, nodePath) {
    try {
        return canInstall(agent) && FORMATS[agent.format].installed(agent, nodePath);
    } catch (e) {
        return false;
    }
}

function hasAnyHooks(agent) {
    try {
        return canInstall(agent) && FORMATS[agent.format].hasAny(agent);
    } catch (e) {
        return false;
    }
}

// Rules for hook.js (it reads them on every call)
function writeAgentsFile(agents) {
    const out = {};
    for (const [id, a] of Object.entries(agents)) out[id] = { events: a.events || {}, stdout: a.stdout || {}, ask: a.ask || {}, chat: a.chat || {} };
    fs.mkdirSync(BASE_DIR, { recursive: true });
    fs.writeFileSync(path.join(BASE_DIR, 'agents.json'), JSON.stringify(out, null, 2));
}

// Lights the hook may send questions to. Holds light passwords, so only the user can read it.
function writeLightsFile(data) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
    const file = path.join(BASE_DIR, 'lights.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (e) { /* not supported on Windows */ }
}

module.exports = {
    BASE_DIR, HOOK_PATH, PRESETS, allAgents, isDetected, hookCommand, canInstall, install, uninstall,
    isInstalled, hasAnyHooks, writeAgentsFile, writeLightsFile, expand,
};
