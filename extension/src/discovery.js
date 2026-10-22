// Finding lights: mDNS (DNS-SD service _codeshelf._tcp) on the network and Espressif USB serial ports.
// The mDNS query goes out from a random port, so lights answer straight back to us (RFC 6762 "legacy
// unicast") and nothing has to share port 5353 with the system's mDNS service.
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SERVICE = '_codeshelf._tcp.local';
const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33 };

function encodeName(name) {
    const parts = name.split('.').filter(Boolean).map((label) => {
        const b = Buffer.from(label, 'utf8');
        return Buffer.concat([Buffer.from([b.length]), b]);
    });
    return Buffer.concat([...parts, Buffer.from([0])]);
}

function buildQuery(name = SERVICE, type = TYPE.PTR) {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 4); // one question
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2); // class IN
    return Buffer.concat([header, encodeName(name), tail]);
}

// Returns [name, offsetAfterName]; follows compression pointers
function readName(buf, offset) {
    const labels = [];
    let pos = offset;
    let end = -1;
    for (let jumps = 0; jumps < 20; jumps++) {
        const len = buf[pos];
        if (len === undefined) throw new Error('truncated name');
        if (len === 0) {
            pos += 1;
            break;
        }
        if ((len & 0xc0) === 0xc0) {
            if (end < 0) end = pos + 2;
            pos = ((len & 0x3f) << 8) | buf[pos + 1];
            continue;
        }
        labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
        pos += 1 + len;
    }
    return [labels.join('.'), end >= 0 ? end : pos];
}

function parseRecords(buf) {
    const qd = buf.readUInt16BE(4);
    const count = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    let pos = 12;
    for (let i = 0; i < qd; i++) pos = readName(buf, pos)[1] + 4;
    const records = [];
    for (let i = 0; i < count; i++) {
        const [name, next] = readName(buf, pos);
        const type = buf.readUInt16BE(next);
        const len = buf.readUInt16BE(next + 8);
        const data = next + 10;
        const rec = { name, type };
        if (type === TYPE.PTR) rec.target = readName(buf, data)[0];
        else if (type === TYPE.SRV) {
            rec.port = buf.readUInt16BE(data + 4);
            rec.target = readName(buf, data + 6)[0];
        } else if (type === TYPE.A) rec.address = [...buf.subarray(data, data + 4)].join('.');
        else if (type === TYPE.TXT) {
            rec.txt = {};
            for (let p = data; p < data + len;) {
                const entry = buf.toString('utf8', p + 1, p + 1 + buf[p]);
                const eq = entry.indexOf('=');
                if (eq > 0) rec.txt[entry.slice(0, eq)] = entry.slice(eq + 1);
                p += 1 + buf[p];
            }
        }
        records.push(rec);
        pos = data + len;
    }
    return records;
}

// Lights from a set of records: [{ name, host, address, port, version }]
function lightsFromRecords(records) {
    const lights = [];
    for (const ptr of records.filter((r) => r.type === TYPE.PTR && r.name.toLowerCase() === SERVICE)) {
        const srv = records.find((r) => r.type === TYPE.SRV && r.name === ptr.target);
        const txt = (records.find((r) => r.type === TYPE.TXT && r.name === ptr.target) || {}).txt || {};
        const a = srv && records.find((r) => r.type === TYPE.A && r.name === srv.target);
        if (!srv) continue;
        lights.push({
            name: txt.name || ptr.target.replace(`.${SERVICE}`, ''),
            host: srv.target,
            address: a ? a.address : null,
            port: srv.port,
            version: txt.version || null,
        });
    }
    return lights;
}

function discoverNetwork(timeoutMs = 2500) {
    return new Promise((resolve) => {
        const found = new Map();
        const sockets = [];
        const query = buildQuery();
        const finish = () => {
            for (const s of sockets) { try { s.close(); } catch (e) { /* already closed */ } }
            resolve([...found.values()]);
        };
        // One socket per IPv4 interface, so the query reaches every network the computer is on
        const interfaces = Object.values(os.networkInterfaces()).flat()
            .filter((i) => i && i.family === 'IPv4' && !i.internal);
        for (const iface of interfaces.length ? interfaces : [{ address: undefined }]) {
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            sockets.push(sock);
            sock.on('error', () => { /* an interface that cannot send multicast */ });
            sock.on('message', (msg, rinfo) => {
                try {
                    for (const light of lightsFromRecords(parseRecords(msg))) {
                        found.set(light.host, { ...light, address: light.address || rinfo.address });
                    }
                } catch (e) { /* not a well-formed answer */ }
            });
            sock.bind(0, iface.address, () => {
                try {
                    if (iface.address) sock.setMulticastInterface(iface.address);
                    sock.send(query, MDNS_PORT, MDNS_ADDRESS);
                    setTimeout(() => { try { sock.send(query, MDNS_PORT, MDNS_ADDRESS); } catch (e) { /* closed */ } }, 600);
                } catch (e) { /* no multicast route on this interface */ }
            });
        }
        setTimeout(finish, timeoutMs);
    });
}

// ---------- USB ----------

let windowsPorts = [];
let windowsPortsAt = 0;

// Windows has no /dev; ask PnP for Espressif (USB VID 303A) devices now and then and cache the answer
function refreshWindowsPorts() {
    if (Date.now() - windowsPortsAt < 30000) return;
    windowsPortsAt = Date.now();
    const script = "Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB\\VID_303A*' -and $_.Name -match '\\(COM\\d+\\)' } | ForEach-Object { $_.Name }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10000, windowsHide: true }, (err, stdout) => {
        if (err) return;
        windowsPorts = [...stdout.matchAll(/\((COM\d+)\)/g)].map((m) => m[1]).sort();
    });
}

// Serial ports that look like a CodeShelf Light (Espressif USB), best first
function espressifPorts() {
    try {
        if (process.platform === 'linux') {
            const byId = '/dev/serial/by-id';
            if (fs.existsSync(byId)) {
                const esp = fs.readdirSync(byId).filter((e) => /espressif|esp32|303a/i.test(e)).sort();
                if (esp.length) return esp.map((e) => path.join(byId, e));
            }
            return fs.readdirSync('/dev').filter((e) => /^ttyACM\d+$/.test(e)).sort().map((e) => '/dev/' + e);
        }
        if (process.platform === 'darwin') {
            return fs.readdirSync('/dev').filter((e) => /^cu\.usbmodem/.test(e)).sort().map((e) => '/dev/' + e);
        }
        if (process.platform === 'win32') {
            refreshWindowsPorts();
            return windowsPorts;
        }
    } catch (e) { /* no /dev access */ }
    return [];
}

// Every serial port, for picking one by hand
function allPorts() {
    const ports = new Set(espressifPorts());
    try {
        if (process.platform === 'linux') {
            fs.readdirSync('/dev').filter((e) => /^tty(ACM|USB)\d+$/.test(e)).forEach((e) => ports.add('/dev/' + e));
        } else if (process.platform === 'darwin') {
            fs.readdirSync('/dev').filter((e) => /^cu\.usb/.test(e)).forEach((e) => ports.add('/dev/' + e));
        }
    } catch (e) { /* no /dev access */ }
    return [...ports];
}

module.exports = { SERVICE, buildQuery, parseRecords, lightsFromRecords, discoverNetwork, espressifPorts, allPorts, encodeName, TYPE };
