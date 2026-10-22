const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const L = require('../src/lights');

test('normalize fills defaults', () => {
    const l = L.normalize({ host: 'http://desk.local/' }, 0);
    assert.deepStrictEqual(l, { name: 'Light 1', host: 'desk.local', connection: 'auto', serialPort: 'auto', password: '', agents: [], projects: [], enabled: true });
    assert.strictEqual(L.normalize({ connection: 'bogus' }, 1).connection, 'auto');
});

test('auto ports skip ports claimed by other lights', () => {
    const lights = [
        L.normalize({ connection: 'usb' }, 0),
        L.normalize({ connection: 'usb', serialPort: '/dev/ttyACM0' }, 1),
        L.normalize({ connection: 'wifi', host: 'a.local' }, 2),
        L.normalize({ connection: 'auto', host: 'b.local' }, 3),
    ];
    assert.deepStrictEqual(L.assignPorts(lights, ['/dev/ttyACM0', '/dev/ttyACM1']), ['/dev/ttyACM1', '/dev/ttyACM0', null, null]);
});

test('HTTP: sends the state and the password', async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push([req.url, req.headers.authorization]);
        res.end('T');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const light = L.normalize({ host: `127.0.0.1:${server.address().port}`, password: 'pw', connection: 'wifi' }, 0);
    const link = new L.Link(() => {});
    assert.strictEqual(link.send(light, null, 'T'), true);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepStrictEqual(seen, [['/set?c=T', 'Basic ' + Buffer.from('admin:pw').toString('base64')]]);
    assert.strictEqual(link.http.ok, true);
    server.close();
});

test('HTTP: an unreachable light is reported, wifi-only does not fall back to USB', async () => {
    const light = L.normalize({ host: '127.0.0.1:9', connection: 'wifi' }, 0);
    const link = new L.Link(() => {});
    link.send(light, '/dev/null', 'T');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(link.send(light, '/dev/null', 'T'), false);
    assert.ok(link.http.lastError);
});
