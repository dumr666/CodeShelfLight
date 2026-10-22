const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const s = require('../src/sessions');

const session = (id, agent, state, cwd, ts = Date.now()) => ({ id, agent, state, effective: state, cwd, ts });

test('the most important state wins', () => {
    const list = [session('a', 'claude-code', 'working'), session('b', 'claude-code', 'attention'), session('c', 'cursor', 'done')];
    assert.strictEqual(s.aggregate(list), 'attention');
    assert.strictEqual(s.aggregate([]), 'idle');
});

test('a custom priority changes the winner', () => {
    const list = [session('a', 'x', 'error'), session('b', 'x', 'attention')];
    assert.strictEqual(s.aggregate(list), 'error');
    assert.strictEqual(s.aggregate(list, ['attention', 'error']), 'attention');
});

test('stale working sessions count as done, then idle', () => {
    const now = Date.now();
    const old = { state: 'working', ts: now - 20 * 60000 };
    assert.strictEqual(s.effectiveState(old, now, { staleWorkingMinutes: 15 }), 'done');
    assert.strictEqual(s.effectiveState(old, now, { staleWorkingMinutes: 15, doneToIdleMinutes: 10 }), 'idle');
    assert.strictEqual(s.effectiveState({ state: 'working', ts: now }, now, { staleWorkingMinutes: 15 }), 'working');
    assert.strictEqual(s.effectiveState({ state: 'bogus', ts: now }, now, {}), 'idle');
});

test('project patterns', () => {
    const home = os.homedir().replace(/\\/g, '/');
    assert.ok(s.matchesProject(`${home}/work/api`, '~/work'));
    assert.ok(s.matchesProject(`${home}/work/api/src`, '~/work/api'));
    assert.ok(!s.matchesProject(`${home}/work/api2`, '~/work/api'));
    assert.ok(s.matchesProject('/srv/client-a/web', '/srv/*/web'));
    assert.ok(!s.matchesProject('/srv/client-a/x/web', '/srv/*/web'));
    assert.ok(s.matchesProject('/srv/client-a/x/web', '/srv/**/web'));
    assert.ok(s.matchesProject('/home/me/code/codeshelf', 'codeshelf'));
    assert.ok(s.matchesProject('/home/me/code/codeshelf-web/src', 'codeshelf*'));
    assert.ok(!s.matchesProject('/home/me/code/other', 'codeshelf'));
    assert.ok(!s.matchesProject(undefined, 'codeshelf'));
});

test('lights follow their agents and projects, minus muted sessions', () => {
    const list = [
        session('claude--1', 'claude-code', 'attention', '/p/alpha'),
        session('cursor--1', 'cursor', 'error', '/p/beta'),
        session('claude--2', 'claude-code', 'working', '/p/beta'),
    ];
    const ids = (l, muted) => s.sessionsForLight(list, l, muted).map((x) => x.id);
    assert.deepStrictEqual(ids({}), ['claude--1', 'cursor--1', 'claude--2']);
    assert.deepStrictEqual(ids({ agents: ['claude-code'] }), ['claude--1', 'claude--2']);
    assert.deepStrictEqual(ids({ projects: ['beta'] }), ['cursor--1', 'claude--2']);
    assert.deepStrictEqual(ids({ agents: ['claude-code'], projects: ['/p/beta'] }), ['claude--2']);
    assert.deepStrictEqual(ids({}, new Set(['cursor--1'])), ['claude--1', 'claude--2']);
});

test('readSessions reads, ids and expires session files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-'));
    fs.writeFileSync(path.join(dir, 'claude-code--abc.json'), JSON.stringify({ agent: 'claude-code', state: 'working', ts: Date.now() }));
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ agent: 'x', state: 'working', ts: Date.now() - 2 * 86400000 }));
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    const list = s.readSessions(dir);
    assert.deepStrictEqual(list.map((x) => x.id), ['claude-code--abc']);
    assert.ok(!fs.existsSync(path.join(dir, 'old.json')));
    fs.rmSync(dir, { recursive: true });
});

test('a transcript ending with an interrupt marker is not working', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')), 't.jsonl');
    const line = (t) => JSON.stringify({ message: { content: [{ type: 'text', text: t }] } }) + '\n';
    const now = Date.now();
    const s = { state: 'working', ts: now, transcript: file };
    fs.writeFileSync(file, line('hi') + line('[Request interrupted by user for tool use]'));
    assert.strictEqual(s.effectiveState(s, now, {}), 'done');
    fs.appendFileSync(file, line('next prompt'));
    assert.strictEqual(s.effectiveState(s, now, {}), 'working');
});
