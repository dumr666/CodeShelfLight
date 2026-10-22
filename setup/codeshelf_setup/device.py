"""Talking to a CodeShelf Light over USB serial.

The firmware reads one JSON request per line and answers with one JSON line that carries the same "id".
Other lines (boot messages, logs) are skipped. See docs/protocol.md.
"""
import json
import time
from dataclasses import dataclass

import serial
from serial.tools import list_ports

ESPRESSIF_VID = 0x303A


class LightError(Exception):
    """The light answered with an error, or did not answer."""


@dataclass
class Port:
    device: str
    description: str

    def __str__(self):
        return f"{self.description} ({self.device})" if self.description and self.description != "n/a" else self.device


def find_ports(all_ports=False):
    """Serial ports of Espressif USB devices, or every port with all_ports."""
    ports = []
    for p in sorted(list_ports.comports(), key=lambda p: p.device):
        if all_ports or p.vid == ESPRESSIF_VID:
            ports.append(Port(p.device, p.product or p.description or ""))
    return ports


class Light:
    def __init__(self, device, open_serial=None):
        self.device = device
        self._next_id = 1
        if open_serial:
            self.serial = open_serial(device)
        else:
            # DTR and RTS stay asserted (the default) so opening the port does not reset the chip
            self.serial = serial.Serial(device, 115200, timeout=0.2, write_timeout=2)

    def close(self):
        try:
            self.serial.close()
        except (OSError, serial.SerialException):
            pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def request(self, cmd, timeout=3.0, **fields):
        rid = self._next_id
        self._next_id += 1
        line = json.dumps({"id": rid, "cmd": cmd, **fields}, separators=(",", ":")) + "\n"
        self.serial.reset_input_buffer()
        self.serial.write(line.encode())
        self.serial.flush()
        deadline = time.monotonic() + timeout
        buf = b""
        while time.monotonic() < deadline:
            chunk = self.serial.read(self.serial.in_waiting or 1)
            if not chunk:
                continue
            buf += chunk
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                reply = _parse(raw)
                if reply is None or reply.get("id") != rid:
                    continue
                if not reply.get("ok"):
                    raise LightError(reply.get("error") or "the light rejected the request")
                return reply
        raise LightError(f"no answer to '{cmd}' (is CodeShelf Light firmware installed?)")

    def info(self, timeout=3.0):
        """{"status": {...}, "config": {...}}"""
        r = self.request("info", timeout=timeout)
        return {"status": r["status"], "config": r["config"]}

    def set(self, **config):
        """Apply settings; returns {"reboot": bool, "config": {...}}."""
        r = self.request("set", config=config)
        return {"reboot": r.get("reboot", False), "config": r["config"]}

    def scan(self):
        return self.request("scan", timeout=20)["networks"]

    def reboot(self):
        self.request("reboot")

    def factory_reset(self):
        self.request("factory-reset")


def _parse(raw):
    text = raw.decode("utf-8", "replace").strip()
    if not text.startswith("{"):
        return None
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def wait_for_port(device, timeout=15.0):
    """After a restart the USB port disappears for a moment. Returns the port to use, or None."""
    deadline = time.monotonic() + timeout
    time.sleep(1.0)
    while time.monotonic() < deadline:
        ports = find_ports()
        for p in ports:
            if p.device == device:
                return p.device
        if len(ports) == 1:  # the name can change (e.g. on macOS); one Espressif device is unambiguous
            return ports[0].device
        time.sleep(0.5)
    return None
