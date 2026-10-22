"""A fake light on a pseudo terminal that speaks the USB protocol (POSIX only).

    python -m tests.fake_light      # prints the port to point the setup app at
"""
import json
import os
import pty
import threading
import tty


class FakeLight:
    def __init__(self):
        self.master, slave = pty.openpty()
        tty.setraw(slave)
        self.port = os.ttyname(slave)
        self._slave = slave
        self.config = {"name": "CodeShelf Light 1A2B", "host": "codeshelf-light-1a2b", "wifi": True, "ble": True,
                       "ssid": "", "auth": False, "brightness": 64, "timeout": 30, "fade": 600, "states": {}}
        self.status = {"version": "1.0.0", "wifiState": "unconfigured", "host": "codeshelf-light-1a2b", "ip": ""}
        self.requests = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _send(self, obj):
        os.write(self.master, (json.dumps(obj) + "\n").encode())

    def _serve(self):
        buf = b""
        while True:
            try:
                buf += os.read(self.master, 1024)
            except OSError:
                return
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                req = json.loads(line)
                self.requests.append(req)
                os.write(self.master, b"some log line\n{not json\n")
                self._send({"id": req["id"] + 1000, "ok": True})  # someone else's reply
                self._reply(req)

    def _reply(self, req):
        rid, cmd = req["id"], req["cmd"]
        if cmd == "info":
            self._send({"id": rid, "ok": True, "status": self.status, "config": self.config})
        elif cmd == "set":
            patch = req["config"]
            if "wifiPassword" in patch and 0 < len(patch["wifiPassword"]) < 8:
                self._send({"id": rid, "ok": False, "error": "WiFi password must be 8-63 characters"})
                return
            if "ssid" in patch:
                self.config["ssid"] = patch["ssid"]
                self.status["wifiState"] = "connected"
                self.status["ip"] = "192.168.1.50"
            self._send({"id": rid, "ok": True, "reboot": False, "config": self.config})
        elif cmd == "scan":
            self._send({"id": rid, "ok": True, "networks": [{"ssid": "Home", "rssi": -40, "secure": True}]})
        elif cmd == "silent":
            pass
        else:
            self._send({"id": rid, "ok": True})


if __name__ == "__main__":
    fake = FakeLight()
    print(fake.port)
    threading.Event().wait()
