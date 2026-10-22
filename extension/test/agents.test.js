// Runs agents.js and hook.js against a temporary home folder
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'csl-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const agents = require('../src/agents');
const all = agents.allAgents([{ id: 'mine', events: { go: 'working' } }]);
const read = (f) => JSON.parse(fs.readFileSync(path.join(home, f), 'utf8'));

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('Claude Code: install keeps the user\'s own hooks, uninstall removes only ours', () => {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({
        model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
    }));
    const claude = all['claude-code'];
    agents.install(claude, 'node');
    assert.ok(agents.isInstalled(claude, 'node'));
    const s = read('.claude/settings.json');
    assert.strictEqual(s.model, 'opus');
    assert.strictEqual(s.hooks.Stop.length, 2);
    assert.strictEqual(s.hooks.PreToolUse[0].matcher, '*');
    agents.install(claude, 'node'); // installing twice does not duplicate
    assert.strictEqual(read('.claude/settings.json').hooks.Stop.length, 2);
    agents.uninstall(claude);
    assert.deepStrictEqual(read('.claude/settings.json').hooks, { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] });
    assert.ok(fs.existsSync(path.join(home, '.claude/settings.json.codeshelf.bak')));
});

test('Cursor and Copilot formats', () => {
    agents.install(all.cursor, 'node');
    assert.strictEqual(read('.cursor/hooks.json').version, 1);
    assert.ok(agents.isInstalled(all.cursor, 'node'));
    agents.uninstall(all.cursor);
    assert.ok(!agents.hasAnyHooks(all.cursor));
    agents.install(all['copilot-cli'], 'node');
    assert.ok(agents.isInstalled(all['copilot-cli'], 'node'));
    agents.uninstall(all['copilot-cli']);
    assert.ok(!fs.existsSync(path.join(home, '.copilot/hooks/codeshelf-light.json')));
});

test('custom agents without a file are not installable', () => {
    assert.strictEqual(agents.canInstall(all.mine), false);
});

function runHook(agent, event, payload) {
    return execFileSync(process.execPath, [path.join(__dirname, '../src/hook.js'), agent, event], {
        input: payload ? JSON.stringify(payload) : '', env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
    });
}

test('hook.js maps events to session states', () => {
    agents.writeAgentsFile(all);
    const dir = path.join(home, '.codeshelf/light/sessions');
    runHook('claude-code', 'UserPromptSubmit', { session_id: 's1', cwd: '/p/a' });
    assert.deepStrictEqual(
        (({ agent, state, event, cwd }) => ({ agent, state, event, cwd }))(JSON.parse(fs.readFileSync(path.join(dir, 'claude-code--s1.json')))),
        { agent: 'claude-code', state: 'working', event: 'UserPromptSubmit', cwd: '/p/a' });
    runHook('claude-code', 'Notification', { session_id: 's1', notification_type: 'permission_prompt' });
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'claude-code--s1.json'))).state, 'attention');
    runHook('claude-code', 'SessionEnd', { session_id: 's1' });
    assert.ok(!fs.existsSync(path.join(dir, 'claude-code--s1.json')));
});

test('hook.js prints only what the agent expects', () => {
    assert.strictEqual(runHook('gemini-cli', 'BeforeTool', { session_id: 'g' }), '{}');
    assert.strictEqual(runHook('claude-code', 'Stop', { session_id: 'c' }), '');
    assert.strictEqual(runHook('mine', 'working'), '');
    assert.strictEqual(runHook('claude-code', 'Stop', null), ''); // no JSON on stdin does not break it
});

test('Claude Code: the hooks that wait for an answer get a long timeout', () => {
    const claude = all['claude-code'];
    agents.install(claude, 'node');
    const hooks = read('.claude/settings.json').hooks;
    const timeout = (ev, matcher) => hooks[ev].find((g) => g.matcher === matcher).hooks[0].timeout;
    assert.strictEqual(timeout('PermissionRequest', '*'), 100);
    assert.strictEqual(timeout('PreToolUse', 'AskUserQuestion'), 100);
    assert.strictEqual(timeout('PreToolUse', '*'), 5);
    assert.ok(agents.isInstalled(claude, 'node'));
    agents.uninstall(claude);
});
