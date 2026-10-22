// Sending states to lights over WiFi (HTTP) or USB serial. One Link per configured light.
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

// Light settings as stored in codeshelfLight.lights, with defaults filled in
function normalize(light, index) {
    const l = light || {};
    return {
        name: String(l.name || `Light ${index + 1}`),
        host: String(l.host || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
        connection: ['auto', 'wifi', 'usb'].includes(l.connection) ? l.connection : 'auto',
        serialPort: l.serialPort || 'auto',
        password: l.password || '',
        agents: Array.isArray(l.agents) ? l.agents : [],
        projects: Array.isArray(l.projects) ? l.projects : [],
        enabled: l.enabled !== false,
    };
}

function request(light, method, urlPath, body, timeout = 3000) {
    const [hostname, port] = light.host.split(':');
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (light.password) headers.Authorization = 'Basic ' + Buffer.from(`admin:${light.password}`).toString('base64');
    return new Promise((resolve, reject) => {
        if (!hostname) {
            reject(new Error('no address set'));
            return;
        }
        const req = http.request({ hostname, port: port || 80, path: urlPath, method, timeout, headers }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                if (res.statusCode === 200) resolve(data);
                else if (res.statusCode === 401) reject(new Error('wrong or missing password'));
                else reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end(body);
    });
}

// Sending is async, so send() returns the result of the previous request
class HttpOut {
    constructor(log) {
        this.log = log;
        this.inFlight = false;
        this.ok = true;
        this.lastError = null;
    }

    send(light, ch) {
        if (this.inFlight) return this.ok; // the light is not answering, do not pile up requests
        this.inFlight = true;
        request(light, 'GET', `/set?c=${encodeURIComponent(ch)}`)
            .then(() => this.done(light, null))
            .catch((e) => this.done(light, e.message));
        return this.ok;
    }

    done(light, err) {
        this.inFlight = false;
        if (!err && this.lastError) this.log(`${light.name}: connected to ${light.host}`);
        if (err && this.lastError !== err) this.log(`${light.name}: ${light.host}: ${err}`);
        this.ok = !err;
        this.lastError = err;
    }
}

// Writes single state characters. The port stays open; reopening could reset the board.
class SerialOut {
    constructor(log) {
        this.log = log;
        this.fd = null;
        this.port = null;
        this.lastError = null;
    }

    open(port) {
        const c = fs.constants;
        let flags = 'r+';
        if (process.platform !== 'win32' && c.O_NONBLOCK !== undefined) flags = c.O_WRONLY | c.O_NOCTTY | c.O_NONBLOCK;
        this.fd = fs.openSync(process.platform === 'win32' ? `\\\\.\\${port}` : port, flags);
        this.port = port;
        // raw without echo; -hupcl so closing does not drop DTR (the board does not reset)
        if (process.platform === 'linux') execFile('stty', ['-F', port, 'raw', '-echo', '-hupcl'], () => {});
        if (process.platform === 'darwin') execFile('stty', ['-f', port, 'raw', '-echo', '-hupcl'], () => {});
        this.log(`Opened ${port}`);
    }

    close() {
        if (this.fd !== null) {
            try { fs.closeSync(this.fd); } catch (e) { /* already closed */ }
        }
        this.fd = null;
        this.port = null;
    }

    send(port, ch) {
        if (!port) {
            this.error('no USB serial port found');
            return false;
        }
        try {
            if (this.fd === null || this.port !== port) {
                this.close();
                this.open(port);
            }
            fs.writeSync(this.fd, ch);
            this.lastError = null;
            return true;
        } catch (e) {
            if (e.code === 'EAGAIN') return true; // buffer full, try on the next heartbeat
            this.close();
            this.error(`${port}: ${e.message}`);
            return false;
        }
    }

    error(msg) {
        if (this.lastError !== msg) this.log(msg);
        this.lastError = msg;
    }
}

// connection: auto = WiFi, USB when WiFi fails (or no address is set); wifi; usb
class Link {
    constructor(log) {
        this.http = new HttpOut(log);
        this.serial = new SerialOut(log);
        this.via = null;
        this.state = null; // last state sent
        this.sentAt = 0;
    }

    send(light, port, ch) {
        let ok = false;
        let via = null;
        if (light.connection !== 'usb' && light.host) {
            ok = this.http.send(light, ch);
            via = 'wifi';
        }
        if (!ok && light.connection !== 'wifi') {
            ok = this.serial.send(port, ch);
            via = 'usb';
        }
        this.via = ok ? via : null;
        return ok;
    }

    describe(light, port) {
        const wifi = light.host ? `${light.host}${this.http.ok ? '' : ` (${this.http.lastError})`}` : 'no address';
        const usb = `${port || 'no port'}${this.serial.lastError ? ` (${this.serial.lastError})` : ''}`;
        if (light.connection === 'usb') return `USB ${usb}`;
        if (light.connection === 'wifi') return `WiFi ${wifi}`;
        return `WiFi ${wifi} · USB fallback ${usb}`;
    }

    close() {
        this.serial.close();
    }
}

// Ports for lights set to "auto": Espressif ports nobody claimed explicitly, in order
function assignPorts(lights, detected) {
    const claimed = new Set(lights.filter((l) => l.serialPort !== 'auto').map((l) => l.serialPort));
    const free = detected.filter((p) => !claimed.has(p));
    return lights.map((l) => {
        if (l.connection === 'wifi') return null;
        if (l.serialPort !== 'auto') return l.serialPort;
        return free.shift() || null;
    });
}

module.exports = { normalize, request, Link, assignPorts };
