// CodeShelf Light for VS Code: reads agent sessions written by the hooks and drives one or more lights.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agents = require('./agents');
const sessions = require('./sessions');
const lights = require('./lights');
const discovery = require('./discovery');

const SESSIONS_DIR = path.join(agents.BASE_DIR, 'sessions');
const LEGACY_DIR = path.join(os.homedir(), '.claude', 'busy-light');
const DEFAULT_CODES = { working: 'T', attention: 'Y', error: 'R', done: 'G', idle: 'G', off: 'O' };
const LABELS = {
    error: { text: 'error', icon: '$(error)', color: 'statusBarItem.errorBackground' },
    attention: { text: 'needs you', icon: '$(bell-dot)', color: 'statusBarItem.warningBackground' },
    working: { text: 'working', icon: '$(sync~spin)' },
    done: { text: 'waiting', icon: '$(check)' },
    idle: { text: 'idle', icon: '$(circle-outline)' },
    off: { text: 'off', icon: '$(circle-slash)' },
};
const HEARTBEAT_MS = 5000;
const TICK_MS = 1000;

let log;
let statusItem;
let ctx;
let links = []; // one Link per entry of codeshelfLight.lights, same order
let testUntil = 0;

const cfg = () => vscode.workspace.getConfiguration('codeshelfLight');
const logLine = (msg) => log.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
const agentList = () => agents.allAgents(cfg().get('customAgents', []));
const agentName = (id) => (agentList()[id] || {}).name || id;
const configuredLights = () => cfg().get('lights', []).map(lights.normalize);
const muted = () => new Set(ctx.globalState.get('mutedSessions', []));

function codeFor(state) {
    return { ...DEFAULT_CODES, ...cfg().get('codes', {}) }[state] || DEFAULT_CODES[state];
}

async function saveLights(list) {
    await cfg().update('lights', list, vscode.ConfigurationTarget.Global);
}

// ---------- State → lights ----------

function currentSessions() {
    const now = Date.now();
    const enabled = new Set(cfg().get('agents', ['claude-code']));
    const opts = { staleWorkingMinutes: cfg().get('staleWorkingMinutes', 15), doneToIdleMinutes: cfg().get('doneToIdleMinutes', 0) };
    return sessions.readSessions(SESSIONS_DIR, now)
        .filter((s) => enabled.has(s.agent))
        .map((s) => ({ ...s, effective: sessions.effectiveState(s, now, opts) }));
}

function tick(force) {
    if (Date.now() < testUntil) return;
    const all = currentSessions();
    const mute = muted();
    const priority = cfg().get('priority', sessions.DEFAULT_PRIORITY);
    const enabled = cfg().get('enabled', true);
    const list = configuredLights();
    const usb = list.some((l) => l.enabled && l.connection !== 'wifi');
    const ports = lights.assignPorts(list, usb ? discovery.espressifPorts() : []);
    syncLinks(list.length);

    const results = list.map((light, i) => {
        const link = links[i];
        const state = !enabled || !light.enabled ? 'off' : sessions.aggregate(sessions.sessionsForLight(all, light, mute), priority);
        if (state !== link.state) logLine(`${light.name}: ${link.state || 'start'} -> ${state}`);
        // Send right away on a change, otherwise repeat now and then (the light may have been off or restarted)
        if (state !== link.state || force || Date.now() - link.sentAt > HEARTBEAT_MS) {
            link.ok = link.send(light, ports[i], codeFor(state));
            link.state = state;
            link.sentAt = Date.now();
        }
        return { light, link, state, port: ports[i] };
    });
    const overall = enabled ? sessions.aggregate(all.filter((s) => !mute.has(s.id)), priority) : 'off';
    updateStatusBar(overall, all, results);
}

function syncLinks(count) {
    while (links.length > count) links.pop().close();
    while (links.length < count) links.push(new lights.Link(logLine));
}

function resetLinks() {
    for (const l of links) l.close();
    links = [];
}

function updateStatusBar(state, all, results) {
    const l = LABELS[state];
    const offline = results.some((r) => r.light.enabled && !r.link.ok);
    statusItem.text = results.length
        ? `${l.icon} CodeShelf: ${l.text}${offline ? ' $(debug-disconnect)' : ''}`
        : '$(lightbulb) CodeShelf: add a light';
    statusItem.backgroundColor = l.color && results.length ? new vscode.ThemeColor(l.color) : undefined;
    const mute = muted();
    const lightLines = results.map((r) =>
        `- **${r.light.name}**: ${LABELS[r.state].text} · ${r.light.enabled ? r.link.describe(r.light, r.port) : 'disabled'}`);
    const sessionLines = all.map((s) =>
        `- ${agentName(s.agent)} · ${path.basename(s.cwd || '?')}: ${s.effective}${mute.has(s.id) ? ' (muted)' : ''}`);
    statusItem.tooltip = new vscode.MarkdownString(
        '**CodeShelf Light**\n\n' +
        (lightLines.length ? lightLines.join('\n') : '_No lights. Click to add one._') + '\n\n' +
        (sessionLines.length ? sessionLines.join('\n') : '_No active agent sessions_'));
}

// ---------- Agents and hooks ----------

function deployHookScript() {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.copyFileSync(path.join(ctx.extensionPath, 'src', 'hook.js'), agents.HOOK_PATH);
    agents.writeAgentsFile(agentList());
}

// Sync hooks with the selected agents: install (or update) for selected ones, remove from the rest
function syncHooks(interactive) {
    const nodePath = cfg().get('nodePath', 'node');
    const enabled = new Set(cfg().get('agents', ['claude-code']));
    agents.writeAgentsFile(agentList());
    const changed = [];
    for (const agent of Object.values(agentList())) {
        if (!agents.canInstall(agent)) continue;
        try {
            if (enabled.has(agent.id) && !agents.isInstalled(agent, nodePath)) {
                agents.install(agent, nodePath);
                changed.push(`+ ${agent.name}`);
            } else if (!enabled.has(agent.id) && agents.hasAnyHooks(agent)) {
                agents.uninstall(agent);
                changed.push(`- ${agent.name}`);
            }
        } catch (e) {
            logLine(`${agent.name}: ${e.message}`);
            vscode.window.showErrorMessage(`CodeShelf Light: ${agent.name} hooks failed: ${e.message}`);
        }
    }
    if (changed.length) logLine(`Hooks: ${changed.join(', ')}`);
    if (interactive) {
        vscode.window.showInformationMessage(changed.length
            ? `CodeShelf Light hooks: ${changed.join(', ')}. New agent sessions will report their status.`
            : 'CodeShelf Light: hooks are up to date.');
    }
}

function uninstallAllHooks() {
    for (const agent of Object.values(agentList())) {
        try { agents.uninstall(agent); } catch (e) { logLine(`${agent.name}: ${e.message}`); }
    }
    ctx.globalState.update('hooksConsent', false);
    vscode.window.showInformationMessage('CodeShelf Light: all hooks removed.');
}

async function selectAgents() {
    const enabled = new Set(cfg().get('agents', ['claude-code']));
    const items = Object.values(agentList()).map((a) => ({
        label: a.name,
        id: a.id,
        description: a.preset ? (agents.isDetected(a) ? 'installed' : 'not found') : 'custom',
        detail: agents.canInstall(a) ? `Hooks in ${a.file}` : 'Add the hook command to your agent yourself (Copy Hook Command)',
        picked: enabled.has(a.id),
    }));
    const picked = await vscode.window.showQuickPick(items, { canPickMany: true, placeHolder: 'Which AI agents report their status?' });
    if (!picked) return;
    ctx.globalState.update('hooksConsent', true);
    await cfg().update('agents', picked.map((p) => p.id), vscode.ConfigurationTarget.Global);
    syncHooks(true);
}

async function copyHookCommand() {
    const all = Object.values(agentList());
    const pick = await vscode.window.showQuickPick(all.map((a) => ({ label: a.name, id: a.id, description: a.preset ? 'preset' : 'custom' })),
        { placeHolder: 'Hook command for which agent?' });
    if (!pick) return;
    const agent = agentList()[pick.id];
    const events = Object.keys(agent.events || {});
    const example = agents.hookCommand(cfg().get('nodePath', 'node'), agent.id, events[0] || 'working');
    await vscode.env.clipboard.writeText(example);
    vscode.window.showInformationMessage(`Copied: ${example}. ` +
        (events.length ? `Events: ${events.join(', ')}.` : 'Use a state as the event: working, attention, error, done, idle, end.'));
}

// ---------- Sessions ----------

async function showSessions() {
    const all = currentSessions();
    if (!all.length) {
        vscode.window.showInformationMessage('CodeShelf Light: no active agent sessions.');
        return;
    }
    const mute = muted();
    const pick = await vscode.window.showQuickPick(all.map((s) => ({
        label: `${LABELS[s.effective].icon} ${agentName(s.agent)} · ${path.basename(s.cwd || '?')}`,
        description: `${LABELS[s.effective].text}${mute.has(s.id) ? ' · muted' : ''}`,
        detail: `${s.cwd || ''} · last event ${s.event} ${Math.round((Date.now() - s.ts) / 1000)} s ago`,
        id: s.id,
    })), { placeHolder: 'Pick a session to mute or unmute it (muted sessions do not light up)' });
    if (!pick) return;
    if (mute.has(pick.id)) mute.delete(pick.id);
    else mute.add(pick.id);
    // Forget sessions that ended
    const live = new Set(all.map((s) => s.id));
    await ctx.globalState.update('mutedSessions', [...mute].filter((id) => live.has(id)));
    tick(true);
}

function resetSessions() {
    try {
        for (const f of fs.readdirSync(SESSIONS_DIR)) fs.rmSync(path.join(SESSIONS_DIR, f), { force: true });
    } catch (e) { /* no sessions folder yet */ }
    ctx.globalState.update('mutedSessions', []);
    tick(true);
}

// ---------- Lights ----------

async function pickLight(placeHolder) {
    const list = configuredLights();
    if (!list.length) {
        const add = await vscode.window.showInformationMessage('CodeShelf Light: no lights yet.', 'Add Light');
        if (add) await addLight();
        return null;
    }
    if (list.length === 1) return 0;
    const pick = await vscode.window.showQuickPick(list.map((l, i) => ({ label: l.name, description: l.host || 'USB', index: i })), { placeHolder });
    return pick ? pick.index : null;
}

async function addLight() {
    const existing = configuredLights();
    const known = new Set(existing.map((l) => l.host.toLowerCase()));
    const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Looking for CodeShelf Lights …' },
        () => discovery.discoverNetwork());
    const items = found.filter((f) => !known.has(f.host.toLowerCase())).map((f) => ({
        label: `$(broadcast) ${f.name}`, description: `${f.host} · ${f.address || ''}`, detail: f.version ? `Firmware ${f.version}` : undefined,
        light: { name: f.name, host: f.host },
    }));
    for (const port of discovery.espressifPorts()) {
        if (existing.some((l) => l.serialPort === port)) continue;
        items.push({ label: `$(plug) USB light on ${port}`, description: 'USB only', light: { name: 'USB Light', connection: 'usb', serialPort: port } });
    }
    items.push({ label: '$(edit) Enter an address …', manual: true });
    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: found.length ? 'Pick a light to add' : 'No lights found on the network. Is it set up and on the same WiFi?',
    });
    if (!pick) return;
    let light = pick.light;
    if (pick.manual) {
        const host = await vscode.window.showInputBox({ prompt: 'Address of the light (name.local or IP)', placeHolder: 'codeshelf-light-1a2b.local' });
        if (!host) return;
        light = { name: host.replace(/\.local$/, ''), host: host.trim() };
        try {
            light.name = JSON.parse(await lights.request(lights.normalize(light, 0), 'GET', '/status')).name || light.name;
        } catch (e) {
            vscode.window.showWarningMessage(`Added ${host}, but it does not answer yet: ${e.message}`);
        }
    }
    await saveLights([...cfg().get('lights', []), light]);
    vscode.window.showInformationMessage(`CodeShelf Light: added ${light.name}.`);
}

async function removeLight() {
    const i = await pickLight('Remove which light?');
    if (i === null) return;
    const list = [...cfg().get('lights', [])];
    const [removed] = list.splice(i, 1);
    await saveLights(list);
    vscode.window.showInformationMessage(`CodeShelf Light: removed ${(removed || {}).name || 'light'}.`);
}

async function updateLight(i, patch) {
    const list = [...cfg().get('lights', [])];
    list[i] = { ...list[i], ...patch };
    await saveLights(list);
}

async function configureLight() {
    const i = await pickLight('Configure which light?');
    if (i === null) return;
    const light = configuredLights()[i];
    const actions = [
        { label: '$(globe) Open settings page', run: () => openDevicePage(i) },
        { label: '$(edit) Rename', run: () => renameLight(i) },
        { label: '$(hubot) Agents', description: light.agents.length ? light.agents.map(agentName).join(', ') : 'all', run: () => chooseLightAgents(i) },
        { label: '$(folder) Projects', description: light.projects.length ? light.projects.join(', ') : 'all', run: () => chooseLightProjects(i) },
        { label: '$(plug) Connection', description: light.connection, run: () => chooseConnection(i) },
        { label: '$(server) Address', description: light.host || 'none', run: () => setAddress(i) },
        { label: '$(key) Password', description: light.password ? 'set' : 'none', run: () => setPassword(i) },
        { label: light.enabled ? '$(circle-slash) Disable' : '$(lightbulb) Enable', run: () => updateLight(i, { enabled: !light.enabled }) },
        { label: '$(beaker) Test states', run: () => testColors(i) },
        { label: '$(trash) Remove', run: async () => {
            const list = [...cfg().get('lights', [])];
            list.splice(i, 1);
            await saveLights(list);
        } },
    ];
    const pick = await vscode.window.showQuickPick(actions, { placeHolder: light.name });
    if (pick) await pick.run();
}

async function renameLight(i) {
    const light = configuredLights()[i];
    const name = await vscode.window.showInputBox({
        prompt: 'New name. It is also the Bluetooth name and the address (<name>.local); the light restarts.',
        value: light.name,
        validateInput: (v) => (v.trim().length < 1 || v.trim().length > 29 ? '1-29 characters' : null),
    });
    if (!name) return;
    if (!light.host) {
        await updateLight(i, { name: name.trim() });
        return;
    }
    try {
        const res = JSON.parse(await lights.request(light, 'POST', '/config', JSON.stringify({ name: name.trim() })));
        await updateLight(i, { name: res.config.name, host: `${res.config.host}.local` });
        vscode.window.showInformationMessage(`Renamed to "${res.config.name}". New address: ${res.config.host}.local`);
    } catch (e) {
        vscode.window.showErrorMessage(`Could not reach ${light.host}: ${e.message}`);
    }
}

async function chooseLightAgents(i) {
    const light = configuredLights()[i];
    const enabled = cfg().get('agents', ['claude-code']);
    const picked = await vscode.window.showQuickPick(enabled.map((id) => ({ label: agentName(id), id, picked: light.agents.includes(id) })),
        { canPickMany: true, placeHolder: `Agents ${light.name} shows (none picked = all)` });
    if (picked) await updateLight(i, { agents: picked.map((p) => p.id) });
}

async function chooseLightProjects(i) {
    const light = configuredLights()[i];
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    const value = await vscode.window.showInputBox({
        prompt: `Projects ${light.name} shows, comma separated: folder paths (~ allowed, * wildcards) or folder names. Empty = all.`,
        value: light.projects.join(', ') || folders.join(', '),
    });
    if (value === undefined) return;
    await updateLight(i, { projects: value.split(',').map((p) => p.trim()).filter(Boolean) });
}

async function chooseConnection(i) {
    const items = [
        { label: 'auto', description: 'WiFi, USB when WiFi does not answer' },
        { label: 'wifi', description: 'Only WiFi' },
        { label: 'usb', description: 'Only USB' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'How to reach the light' });
    if (!pick) return;
    await updateLight(i, { connection: pick.label });
    if (pick.label !== 'wifi') {
        const ports = [{ label: 'auto', description: 'First Espressif USB device' }, ...discovery.allPorts().map((p) => ({ label: p }))];
        const port = await vscode.window.showQuickPick(ports, { placeHolder: 'USB serial port' });
        if (port) await updateLight(i, { serialPort: port.label });
    }
}

async function setAddress(i) {
    const host = await vscode.window.showInputBox({ prompt: 'Address of the light (name.local or IP)', value: configuredLights()[i].host });
    if (host !== undefined) await updateLight(i, { host: host.trim() });
}

async function setPassword(i) {
    const password = await vscode.window.showInputBox({
        prompt: 'The page password set on the light (needed to rename it from here). Empty = none.',
        password: true,
    });
    if (password !== undefined) await updateLight(i, { password });
}

async function openDevicePage(index) {
    const i = typeof index === 'number' ? index : await pickLight('Open which light?');
    if (i === null) return;
    const light = configuredLights()[i];
    if (!light.host) {
        vscode.window.showWarningMessage(`${light.name} has no WiFi address.`);
        return;
    }
    vscode.env.openExternal(vscode.Uri.parse(`http://${light.host}/`));
}

async function testColors(index) {
    const i = typeof index === 'number' ? index : await pickLight('Test which light?');
    if (i === null) return;
    const states = ['working', 'done', 'attention', 'error', 'off'];
    const pick = await vscode.window.showQuickPick([{ label: 'Cycle all' }, ...states.map((s) => ({ label: s, description: codeFor(s) }))],
        { placeHolder: 'Send a test state to the light' });
    if (!pick) return;
    const seq = pick.label === 'Cycle all' ? states : [pick.label];
    const light = configuredLights()[i];
    const port = lights.assignPorts(configuredLights(), discovery.espressifPorts())[i];
    testUntil = Date.now() + seq.length * 2500 + 1000;
    for (const s of seq) {
        links[i].send(light, port, codeFor(s));
        await new Promise((r) => setTimeout(r, 2500));
    }
    testUntil = 0;
    tick(true);
}

async function toggle() {
    await cfg().update('enabled', !cfg().get('enabled', true), vscode.ConfigurationTarget.Global);
}

async function menu() {
    const items = [
        { label: '$(add) Add light', cmd: 'codeshelfLight.addLight' },
        { label: '$(settings-gear) Configure light', cmd: 'codeshelfLight.configureLight' },
        { label: '$(globe) Open light settings page', cmd: 'codeshelfLight.openDevicePage' },
        { label: '$(hubot) Choose agents', cmd: 'codeshelfLight.selectAgents' },
        { label: '$(list-unordered) Sessions', cmd: 'codeshelfLight.showSessions' },
        { label: '$(beaker) Test states', cmd: 'codeshelfLight.test' },
        { label: cfg().get('enabled', true) ? '$(circle-slash) Disable' : '$(lightbulb) Enable', cmd: 'codeshelfLight.toggle' },
        { label: '$(output) Show log', cmd: 'codeshelfLight.showLog' },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'CodeShelf Light' });
    if (pick) vscode.commands.executeCommand(pick.cmd);
}

// ---------- First start and migration ----------

// Claude Busy Light 0.x: its hooks were already approved, replace them with new ones and remove the old data
function migrateLegacyHooks() {
    const claude = agentList()['claude-code'];
    if (!agents.hasAnyHooks(claude)) return false;
    if (!fs.readFileSync(agents.expand(claude.file), 'utf8').includes('busy-light/hook.js')) return false;
    ctx.globalState.update('hooksConsent', true);
    fs.rmSync(LEGACY_DIR, { recursive: true, force: true });
    logLine('Migrated hooks from Claude Busy Light');
    return true;
}

// Extension 1.0 had one light in codeshelfLight.host / connection / serialPort
async function migrateSingleLight() {
    if (cfg().get('lights', []).length) return false;
    const old = ['host', 'connection', 'serialPort'].map((k) => cfg().inspect(k) || {});
    if (!old.some((o) => o.globalValue !== undefined)) return false;
    const [host, connection, serialPort] = old.map((o) => o.globalValue);
    await saveLights([{ name: 'CodeShelf Light', host: host || 'codeshelf-light.local', connection: connection || 'auto', serialPort: serialPort || 'auto' }]);
    for (const k of ['host', 'connection', 'serialPort']) await cfg().update(k, undefined, vscode.ConfigurationTarget.Global);
    logLine('Moved the light settings into codeshelfLight.lights');
    return true;
}

// No lights yet: add the ones on the network, or offer to
async function findLightsOnFirstStart() {
    if (cfg().get('lights', []).length || ctx.globalState.get('autoDiscoveryDone')) return;
    await ctx.globalState.update('autoDiscoveryDone', true);
    const found = await discovery.discoverNetwork();
    if (found.length === 1) {
        await saveLights([{ name: found[0].name, host: found[0].host }]);
        vscode.window.showInformationMessage(`CodeShelf Light: found and added ${found[0].name} (${found[0].host}).`);
    } else if (found.length > 1) {
        const add = await vscode.window.showInformationMessage(`CodeShelf Light: found ${found.length} lights on your network.`, 'Add Lights…');
        if (add) addLight();
    } else if (discovery.espressifPorts().length) {
        await saveLights([{ name: 'USB Light', connection: 'usb' }]);
        vscode.window.showInformationMessage('CodeShelf Light: using the light on USB. Set up WiFi with the CodeShelf Light Setup app.');
    }
}

function activate(context) {
    ctx = context;
    log = vscode.window.createOutputChannel('CodeShelf Light');
    statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusItem.command = 'codeshelfLight.menu';
    statusItem.show();

    try {
        deployHookScript();
    } catch (e) {
        logLine(`Failed to deploy the hook script: ${e.message}`);
    }

    const commands = {
        menu, addLight, removeLight, configureLight, openDevicePage, selectAgents, copyHookCommand, showSessions,
        test: testColors, reset: resetSessions, toggle,
        installHooks: () => { ctx.globalState.update('hooksConsent', true); syncHooks(true); },
        uninstallHooks: uninstallAllHooks,
        showLog: () => log.show(),
    };
    for (const [name, fn] of Object.entries(commands)) {
        context.subscriptions.push(vscode.commands.registerCommand(`codeshelfLight.${name}`, () => fn()));
    }

    context.subscriptions.push(
        log,
        statusItem,
        { dispose: resetLinks },
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration('codeshelfLight')) return;
            if (['agents', 'customAgents', 'nodePath'].some((k) => e.affectsConfiguration(`codeshelfLight.${k}`))) {
                if (ctx.globalState.get('hooksConsent')) syncHooks(false);
                else agents.writeAgentsFile(agentList());
            }
            if (e.affectsConfiguration('codeshelfLight.lights')) resetLinks();
            tick(true);
        }),
    );

    // fs.watch for an instant response, an interval for timeouts, heartbeat and reconnect
    try {
        const watcher = fs.watch(SESSIONS_DIR, () => tick(false));
        context.subscriptions.push({ dispose: () => watcher.close() });
    } catch (e) {
        logLine(`fs.watch unavailable: ${e.message}`);
    }
    const interval = setInterval(() => tick(false), TICK_MS);
    context.subscriptions.push({ dispose: () => clearInterval(interval) });

    migrateSingleLight().then(() => findLightsOnFirstStart()).catch((e) => logLine(e.message)).finally(() => tick(true));

    if (migrateLegacyHooks() || ctx.globalState.get('hooksConsent')) {
        syncHooks(false);
    } else if (!ctx.globalState.get('hookPromptDismissed')) {
        const names = cfg().get('agents', ['claude-code']).map(agentName).join(', ');
        vscode.window.showInformationMessage(`CodeShelf Light reads agent status through hooks. Add hooks for ${names}?`,
            'Add hooks', 'Choose agents', "Don't ask again").then((choice) => {
            if (choice === 'Add hooks') commands.installHooks();
            else if (choice === 'Choose agents') selectAgents();
            else if (choice === "Don't ask again") ctx.globalState.update('hookPromptDismissed', true);
        });
    }
}

// The light turns itself off when no updates arrive (its timeout), so other VS Code windows that
// still run keep it lit; sending "off" here would make it flicker.
function deactivate() {
    resetLinks();
}

module.exports = { activate, deactivate };
