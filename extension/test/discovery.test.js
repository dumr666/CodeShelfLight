const test = require('node:test');
const assert = require('node:assert');
const d = require('../src/discovery');

// A response like the one an ESP32 sends for _codeshelf._tcp.local, with name compression
function response() {
    const parts = [];
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8400, 2);
    header.writeUInt16BE(1, 6); // 1 answer
    header.writeUInt16BE(3, 10); // 3 additional
    parts.push(header);
    let offset = 12;
    const push = (b) => { parts.push(b); offset += b.length; };
    const rr = (nameBuf, type, data) => {
        const meta = Buffer.alloc(10);
        meta.writeUInt16BE(type, 0);
        meta.writeUInt16BE(1, 2);
        meta.writeUInt32BE(120, 4);
        meta.writeUInt16BE(data.length, 8);
        push(Buffer.concat([nameBuf, meta, data]));
    };
    const serviceAt = offset;
    const service = d.encodeName('_codeshelf._tcp.local');
    const ptr = (at) => Buffer.from([0xc0 | (at >> 8), at & 0xff]);
    // PTR: service -> "Desk._codeshelf._tcp.local" (instance label + pointer to the service name)
    const instanceAt = offset + service.length + 10;
    rr(service, d.TYPE.PTR, Buffer.concat([Buffer.from([4]), Buffer.from('Desk'), ptr(serviceAt)]));
    // SRV on the instance (pointer), target desk.local
    const srv = Buffer.alloc(6);
    srv.writeUInt16BE(80, 4);
    const hostAt = offset + 2 + 10 + 6;
    rr(ptr(instanceAt), d.TYPE.SRV, Buffer.concat([srv, d.encodeName('desk.local')]));
    const txt = Buffer.concat([Buffer.from([14]), Buffer.from('name=Desk Lamp'), Buffer.from([13]), Buffer.from('version=1.0.0')]);
    rr(ptr(instanceAt), d.TYPE.TXT, txt);
    rr(ptr(hostAt), d.TYPE.A, Buffer.from([192, 168, 1, 50]));
    return Buffer.concat(parts);
}

test('query asks for the service PTR', () => {
    const q = d.buildQuery();
    assert.strictEqual(q.readUInt16BE(4), 1);
    assert.ok(q.includes(Buffer.from('_codeshelf')));
});

test('parses an mDNS answer into a light', () => {
    const lights = d.lightsFromRecords(d.parseRecords(response()));
    assert.deepStrictEqual(lights, [{ name: 'Desk Lamp', host: 'desk.local', address: '192.168.1.50', port: 80, version: '1.0.0' }]);
});

test('ignores other services', () => {
    const recs = [{ type: d.TYPE.PTR, name: '_http._tcp.local', target: 'x._http._tcp.local' }];
    assert.deepStrictEqual(d.lightsFromRecords(recs), []);
});
