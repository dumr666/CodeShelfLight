#!/usr/bin/env node
// CodeShelf Light background service: sends the agent status to the lights without VS Code.
// Reads the sessions written by hook.js and the settings the extension mirrors to daemon.json.
// While it runs it touches daemon.alive, and the extension leaves the sending to it.
// Run it by hand (node daemon.js) or as a service (see "CodeShelf Light: Install Background Service").
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessions = require('./sessions');
const lights = require('./lights');
const discovery = require('./discovery');

const BASE = path.join(os.homedir(), '.codeshelf', 'light');
const SESSIONS = path.join(BASE, 'sessions');
const CONFIG = path.join(BASE, 'daemon.json');
const ALIVE = path.join(BASE, 'daemon.alive');
const DEFAULT_CODES = { working: 'T', attention: 'Y', error: 'R', done: 'G', idle: 'G', off: 'O' };
const HEARTBEAT_MS = 5000;
const TICK_MS = 1000;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
let links = [];

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    } catch (e) {
        return null; // the extension has not written it yet
    }
}

function tick() {
    const cfg = loadConfig();
    if (!cfg) return;
    const now = Date.now();
    const enabledAgents = new Set(cfg.agents || ['claude-code']);
    const muted = new Set(cfg.muted || []);
    const opts = { staleWorkingMinutes: cfg.staleWorkingMinutes, doneToIdleMinutes: cfg.doneToIdleMinutes };
    const all = sessions.readSessions(SESSIONS, now)
        .filter((s) => enabledAgents.has(s.agent))
        .map((s) => ({ ...s, effective: sessions.effectiveState(s, now, opts) }));
    const list = (cfg.lights || []).map(lights.normalize);
    const usb = list.some((l) => l.enabled && l.connection !== 'wifi');
    const ports = lights.assignPorts(list, usb ? discovery.espressifPorts() : []);
    while (links.length > list.length) links.pop().close();
    while (links.length < list.length) links.push(new lights.Link(log));
    const codes = { ...DEFAULT_CODES, ...(cfg.codes || {}) };

    list.forEach((light, i) => {
        const link = links[i];
        const enabled = cfg.enabled !== false && light.enabled;
        const state = enabled ? sessions.aggregate(sessions.sessionsForLight(all, light, muted), cfg.priority || sessions.DEFAULT_PRIORITY) : 'off';
        if (state !== link.state) log(`${light.name}: ${link.state || 'start'} -> ${state}`);
        if (state !== link.state || now - link.sentAt > HEARTBEAT_MS) {
            link.send(light, ports[i], codes[state] || DEFAULT_CODES[state]);
            link.state = state;
            link.sentAt = now;
        }
    });
    try { fs.writeFileSync(ALIVE, String(now)); } catch (e) { /* folder missing */ }
}

fs.mkdirSync(SESSIONS, { recursive: true });
log('CodeShelf Light background service started');
tick();
setInterval(tick, TICK_MS);
try { fs.watch(SESSIONS, () => tick()); } catch (e) { log(`fs.watch unavailable: ${e.message}`); }
const stop = () => { try { fs.rmSync(ALIVE, { force: true }); } catch (e) { /* ignore */ } process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
