#!/usr/bin/env python3
"""Fake light for working on web/index.html without hardware.

    python3 web/mock_device.py            # then open http://127.0.0.1:8765/

Serves the page and answers the HTTP API from docs/protocol.md with state kept in memory.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

PAGE = Path(__file__).with_name("index.html")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
WRITE_ONLY = ("preview", "wifiPassword", "adminPassword")

config = {
    "name": "CodeShelf Light", "host": "codeshelf-light", "wifi": True, "ble": True, "ssid": "Home", "auth": False,
    "brightness": 64, "timeout": 30, "fade": 600,
    "states": {
        "working": ["#0000ff", "breathe", 2600], "waiting": ["#00ff00", "solid", 2000],
        "attention": ["#ff4600", "solid", 1200], "error": ["#ff0000", "solid", 1000], "off": ["#000000", "solid", 1000],
    },
}
status = {"mode": "T", "source": "wifi", "wifiState": "connected", "ip": "127.0.0.1", "rssi": -48, "mac": "00:11:22:33:44:55",
          "bleClients": 0, "uptime": 0, "heap": 210000, "version": "mock", "build": "mock"}
started = time.time()
log = []  # requests that change something, for tests


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path == "/":
            return self.send(200, PAGE.read_bytes(), "text/html")
        if url.path == "/status":
            s = {**status, "name": config["name"], "host": config["host"], "wifi": config["wifi"], "ble": config["ble"],
                 "ssid": config["ssid"], "brightness": config["brightness"], "uptime": int(time.time() - started),
                 "lastCommandAgo": 2, "state": status["mode"]}
            return self.send(200, json.dumps(s))
        if url.path == "/config":
            return self.send(200, json.dumps(config))
        if url.path == "/scan":
            return self.send(200, json.dumps([{"ssid": "Home", "rssi": -45, "secure": True},
                                              {"ssid": "Guest <b>", "rssi": -70, "secure": False}]))
        if url.path == "/log":
            return self.send(200, json.dumps(log))
        log.append("GET " + self.path)
        if url.path == "/set":
            status["mode"] = q["c"][0]
            status["source"] = "web" if q.get("manual") else "wifi"
            return self.send(200, status["mode"], "text/plain")
        if url.path == "/brightness":
            config["brightness"] = int(q["v"][0])
            return self.send(200, str(config["brightness"]), "text/plain")
        self.send(404, "{}")

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        log.append(f"POST {self.path} {body}")
        if self.path == "/config":
            patch = json.loads(body)
            reboot = any(k in patch and patch[k] != config[k] for k in ("name", "wifi", "ble"))
            for k, v in patch.items():
                if k == "states":
                    config["states"].update(v)
                elif k == "adminPassword":
                    config["auth"] = bool(v)
                elif k not in WRITE_ONLY:
                    config[k] = v
            return self.send(200, json.dumps({"reboot": reboot, "config": config}))
        self.send(200, "OK", "text/plain")


if __name__ == "__main__":
    print(f"Mock light on http://127.0.0.1:{PORT}/")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
