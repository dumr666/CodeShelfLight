"""CodeShelf Light Setup: install the firmware and set up WiFi and the name over USB."""
import argparse
import os
import queue
import threading
import time
import tkinter as tk
import webbrowser
from tkinter import filedialog, messagebox, ttk

from . import __version__
from .device import Light, LightError, Port, find_ports, wait_for_port
from .flasher import bundled_package, flash, load_package

WIFI_STATES = {
    "connected": "Connected",
    "connecting": "Connecting …",
    "wrong-password": "Wrong password",
    "not-found": "Network not found",
    "unconfigured": "Not set up",
    "off": "Turned off",
}
PAD = 12


class SetupApp:
    def __init__(self, root, extra_port=None):
        self.root = root
        self.extra_port = extra_port  # a port find_ports() does not list, e.g. a test device
        self.events = queue.Queue()
        self.busy = False
        self.ports = []
        self.info = None  # last {"status", "config"} from the selected light
        self.package = bundled_package()

        root.title("CodeShelf Light Setup")
        root.minsize(520, 560)
        self._build()
        self.root.after(100, self._drain_events)
        self.refresh_ports()

    # ---------- Layout ----------

    def _build(self):
        main = ttk.Frame(self.root, padding=PAD)
        main.pack(fill="both", expand=True)
        main.columnconfigure(0, weight=1)

        ttk.Label(main, text="CodeShelf Light Setup", font=("TkDefaultFont", 16, "bold")).grid(sticky="w")
        ttk.Label(main, text="Connect the light with a USB cable, then install the firmware and join your WiFi.",
                  wraplength=480).grid(sticky="w", pady=(2, PAD))

        dev = ttk.LabelFrame(main, text="1. Light", padding=PAD)
        dev.grid(sticky="ew")
        dev.columnconfigure(0, weight=1)
        self.port_var = tk.StringVar()
        self.port_box = ttk.Combobox(dev, textvariable=self.port_var, state="readonly")
        self.port_box.grid(row=0, column=0, sticky="ew")
        self.port_box.bind("<<ComboboxSelected>>", lambda e: self.connect())
        ttk.Button(dev, text="Refresh", command=self.refresh_ports).grid(row=0, column=1, padx=(8, 0))
        self.all_ports = tk.BooleanVar(value=False)
        ttk.Checkbutton(dev, text="Show all serial ports", variable=self.all_ports,
                        command=self.refresh_ports).grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.device_label = ttk.Label(dev, text="", wraplength=470, justify="left")
        self.device_label.grid(row=2, column=0, columnspan=2, sticky="w", pady=(8, 0))

        fw = ttk.LabelFrame(main, text="2. Firmware", padding=PAD)
        fw.grid(sticky="ew", pady=(PAD, 0))
        fw.columnconfigure(0, weight=1)
        self.fw_label = ttk.Label(fw, text="", wraplength=360, justify="left")
        self.fw_label.grid(row=0, column=0, sticky="w")
        self.flash_btn = ttk.Button(fw, text="Install firmware", command=self.install_firmware)
        self.flash_btn.grid(row=0, column=1, padx=(8, 0))
        self.progress = ttk.Progressbar(fw, maximum=1.0)
        self.progress.grid(row=1, column=0, columnspan=2, sticky="ew", pady=(8, 0))
        self.progress.grid_remove()

        cfg = ttk.LabelFrame(main, text="3. Settings", padding=PAD)
        cfg.grid(sticky="ew", pady=(PAD, 0))
        cfg.columnconfigure(1, weight=1)
        self.name_var = tk.StringVar()
        self.ssid_var = tk.StringVar()
        self.wifi_pass_var = tk.StringVar()
        self.admin_pass_var = tk.StringVar()
        self.show_pass = tk.BooleanVar(value=False)

        ttk.Label(cfg, text="Name").grid(row=0, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.name_var).grid(row=0, column=1, columnspan=2, sticky="ew", pady=3)
        ttk.Label(cfg, text="WiFi network").grid(row=1, column=0, sticky="w", padx=(0, 8))
        self.ssid_box = ttk.Combobox(cfg, textvariable=self.ssid_var)
        self.ssid_box.grid(row=1, column=1, sticky="ew", pady=3)
        self.scan_btn = ttk.Button(cfg, text="Scan", command=self.scan)
        self.scan_btn.grid(row=1, column=2, padx=(8, 0))
        ttk.Label(cfg, text="WiFi password").grid(row=2, column=0, sticky="w")
        self.pass_entry = ttk.Entry(cfg, textvariable=self.wifi_pass_var, show="•")
        self.pass_entry.grid(row=2, column=1, sticky="ew", pady=3)
        ttk.Checkbutton(cfg, text="Show", variable=self.show_pass,
                        command=lambda: self.pass_entry.configure(show="" if self.show_pass.get() else "•")
                        ).grid(row=2, column=2, padx=(8, 0), sticky="w")
        ttk.Label(cfg, text="Page password").grid(row=3, column=0, sticky="w")
        ttk.Entry(cfg, textvariable=self.admin_pass_var, show="•").grid(row=3, column=1, sticky="ew", pady=3)
        ttk.Label(cfg, text="optional", foreground="gray").grid(row=3, column=2, padx=(8, 0), sticky="w")
        ttk.Label(cfg, text="The page password protects the light's settings page (user admin). "
                            "Leave it empty to keep the current one.", foreground="gray", wraplength=470
                  ).grid(row=4, column=0, columnspan=3, sticky="w", pady=(2, 8))
        self.save_btn = ttk.Button(cfg, text="Save to light", command=self.save)
        self.save_btn.grid(row=5, column=0, columnspan=3, sticky="e")

        done = ttk.Frame(main)
        done.grid(sticky="ew", pady=(PAD, 0))
        done.columnconfigure(0, weight=1)
        self.result_label = ttk.Label(done, text="", wraplength=360, justify="left")
        self.result_label.grid(row=0, column=0, sticky="w")
        self.open_btn = ttk.Button(done, text="Open settings page", command=self.open_page)
        self.open_btn.grid(row=0, column=1, padx=(8, 0))

        more = ttk.Frame(main)
        more.grid(sticky="ew", pady=(PAD, 0))
        ttk.Button(more, text="Restart light", command=self.restart).pack(side="left")
        ttk.Button(more, text="Factory reset …", command=self.factory_reset).pack(side="left", padx=(8, 0))
        ttk.Button(more, text="Other firmware …", command=self.choose_firmware).pack(side="left", padx=(8, 0))

        self.status = ttk.Label(main, text="", foreground="gray", wraplength=480, justify="left")
        self.status.grid(sticky="ew", pady=(PAD, 0))
        ttk.Label(main, text=f"Setup app {__version__}", foreground="gray").grid(sticky="e")
        self._update()

    # ---------- Background work ----------

    def _run(self, label, work, done=None):
        """Run work() off the UI thread; done(result) or an error message comes back through the queue."""
        if self.busy:
            return
        self.busy = True
        self._set_status(label)
        self._update()

        def target():
            try:
                result = work()
                self.events.put(("done", done, result))
            except (LightError, RuntimeError, OSError) as e:
                self.events.put(("error", None, str(e)))
            except Exception as e:  # keep the app alive on surprises; the message is still useful
                self.events.put(("error", None, f"{type(e).__name__}: {e}"))

        threading.Thread(target=target, daemon=True).start()

    def _post(self, fn, *args):
        """Call fn on the UI thread."""
        self.events.put(("call", fn, args))

    def _drain_events(self):
        try:
            while True:
                kind, fn, value = self.events.get_nowait()
                if kind == "call":
                    fn(*value)
                    continue
                self.busy = False
                if kind == "error":
                    self._set_status(value, error=True)
                elif fn:
                    fn(value)
                self._update()
        except queue.Empty:
            pass
        self.root.after(100, self._drain_events)

    def _set_status(self, text, error=False):
        self.status.configure(text=text, foreground="#c0392b" if error else "gray")

    def _port(self):
        i = self.port_box.current()
        return self.ports[i].device if 0 <= i < len(self.ports) else None

    # ---------- Actions ----------

    def refresh_ports(self):
        self.ports = find_ports(self.all_ports.get())
        if self.extra_port:
            self.ports.insert(0, Port(self.extra_port, "Given on the command line"))
        self.port_box["values"] = [str(p) for p in self.ports]
        if self.ports:
            self.port_box.current(0)
            self.connect()
        else:
            self.port_var.set("")
            self.info = None
            self._set_status("No light found. Connect it with a USB cable (a data cable, not a charge-only one) "
                             "and press Refresh.")
            self._update()

    def connect(self):
        port = self._port()
        if not port:
            return

        def work():
            # No answer usually means a new board without the firmware
            try:
                with Light(port) as light:
                    return light.info(timeout=2.5)
            except LightError:
                return None

        def done(info):
            self.info = info
            if info:
                self._fill_form()
                self._set_status("")
            else:
                self._set_status("This device does not run the CodeShelf Light firmware yet. Install it in step 2.")

        self._run(f"Connecting to {port} …", work, done)

    def _fill_form(self):
        c = self.info["config"]
        self.name_var.set(c["name"])
        self.ssid_var.set(c.get("ssid", ""))
        self.wifi_pass_var.set("")
        self.admin_pass_var.set("")

    def install_firmware(self):
        port = self._port()
        if not port or not self.package:
            return
        if not messagebox.askokcancel("Install firmware",
                                      f"Install CodeShelf Light {self.package.version} on {port}?\n\n"
                                      "The light keeps its settings. Do not unplug it while installing."):
            return
        self.progress["value"] = 0
        self.progress.grid()

        def work():
            flash(port, self.package,
                  on_progress=lambda f: self._post(self.progress.configure, {"value": f}),
                  on_message=lambda m: self._post(self._set_status, m))
            new_port = wait_for_port(port)
            if not new_port:
                raise RuntimeError("Firmware installed, but the light did not come back. Unplug it, plug it in "
                                   "again and press Refresh.")
            with Light(new_port) as light:
                return light.info(timeout=8)

        def done(info):
            self.progress.grid_remove()
            self.info = info
            self._fill_form()
            self._set_status(f"Firmware {info['status']['version']} installed. Now join your WiFi in step 3.")

        self._run("Installing firmware …", work, done)

    def scan(self):
        port = self._port()
        if not port or not self.info:
            return

        def work():
            with Light(port) as light:
                return light.scan()

        def done(networks):
            names = [n["ssid"] for n in networks]
            self.ssid_box["values"] = names
            if names and not self.ssid_var.get():
                self.ssid_var.set(names[0])
            self._set_status(f"Found {len(names)} networks." if names else "No networks found.")

        self._run("Scanning for WiFi networks …", work, done)

    def save(self):
        port = self._port()
        if not port or not self.info:
            return
        name = self.name_var.get().strip()
        ssid = self.ssid_var.get().strip()
        wifi_pass = self.wifi_pass_var.get()
        if not 1 <= len(name) <= 29:
            messagebox.showerror("Name", "The name must be 1-29 characters.")
            return
        if wifi_pass and not 8 <= len(wifi_pass) <= 63:
            messagebox.showerror("WiFi password", "WiFi passwords are 8-63 characters.")
            return
        old = self.info["config"]
        patch = {}
        if name != old["name"]:
            patch["name"] = name
        if ssid != old.get("ssid", "") or wifi_pass:
            patch["ssid"] = ssid
            patch["wifiPassword"] = wifi_pass
        if self.admin_pass_var.get():
            patch["adminPassword"] = self.admin_pass_var.get()
        if ssid and not old.get("wifi", True):
            patch["wifi"] = True

        def work():
            with Light(port) as light:
                result = light.set(**patch) if patch else {"reboot": False}
            current = port
            if result["reboot"]:
                current = wait_for_port(port)
                if not current:
                    raise RuntimeError("The light restarted but did not come back. Press Refresh.")
            # Wait for WiFi to connect or fail
            info = None
            for _ in range(40):
                with Light(current) as light:
                    info = light.info(timeout=4)
                state = info["status"]["wifiState"]
                self._post(self._set_status, f"WiFi: {WIFI_STATES.get(state, state)}")
                if state in ("connected", "wrong-password", "not-found", "unconfigured", "off"):
                    break
                time.sleep(1.0)
            return info

        def done(info):
            self.info = info
            self._fill_form()
            state = info["status"]["wifiState"]
            if state == "connected":
                self._set_status("Saved. The light is on your WiFi.")
            else:
                self._set_status(f"Saved, but WiFi is: {WIFI_STATES.get(state, state)}", error=state != "unconfigured")

        self._run("Saving …", work, done)

    def restart(self):
        port = self._port()
        if not port or not self.info:
            return

        def work():
            with Light(port) as light:
                light.reboot()
            current = wait_for_port(port)
            if not current:
                raise RuntimeError("The light did not come back. Press Refresh.")
            with Light(current) as light:
                return light.info(timeout=8)

        def done(info):
            self.info = info
            self._set_status("Restarted.")

        self._run("Restarting …", work, done)

    def factory_reset(self):
        port = self._port()
        if not port or not self.info:
            return
        if not messagebox.askyesno("Factory reset", "Erase the name, WiFi, password and colors on this light?",
                                   icon="warning"):
            return

        def work():
            with Light(port) as light:
                light.factory_reset()
            current = wait_for_port(port)
            if not current:
                raise RuntimeError("The light did not come back. Press Refresh.")
            with Light(current) as light:
                return light.info(timeout=8)

        def done(info):
            self.info = info
            self._fill_form()
            self._set_status("The light is back to factory settings.")

        self._run("Resetting …", work, done)

    def choose_firmware(self):
        path = filedialog.askopenfilename(title="Choose flash.json of a firmware package",
                                          filetypes=[("Firmware package", "flash.json")])
        if not path:
            return
        try:
            self.package = load_package(os.path.dirname(path))
        except (OSError, ValueError, KeyError) as e:
            messagebox.showerror("Firmware", f"Not a firmware package: {e}")
        self._update()

    def open_page(self):
        if self.info:
            s = self.info["status"]
            webbrowser.open(f"http://{s['host']}.local/")

    # ---------- State → widgets ----------

    def _update(self):
        connected = self.info is not None
        idle = not self.busy
        if connected:
            s, c = self.info["status"], self.info["config"]
            wifi = WIFI_STATES.get(s["wifiState"], s["wifiState"])
            where = f" · {c['ssid']}" if c.get("ssid") else ""
            self.device_label.configure(text=f"{c['name']} · firmware {s['version']}\nWiFi: {wifi}{where}")
            if s["wifiState"] == "connected":
                self.result_label.configure(text=f"Settings page: http://{s['host']}.local/  ({s['ip']})")
            else:
                self.result_label.configure(text="")
        else:
            self.device_label.configure(text="")
            self.result_label.configure(text="")

        if self.package:
            installed = self.info["status"]["version"] if connected else None
            text = f"CodeShelf Light {self.package.version}"
            text += f" (installed: {installed})" if installed else (" (not installed)" if self._port() else "")
            self.fw_label.configure(text=text)
            self.flash_btn.configure(text="Update firmware" if connected else "Install firmware")
        else:
            self.fw_label.configure(text="No firmware bundled. Choose one with “Other firmware …”.")

        def state(widget, enabled):
            widget.configure(state="normal" if enabled else "disabled")

        state(self.flash_btn, idle and bool(self._port()) and self.package is not None)
        for w in (self.scan_btn, self.save_btn):
            state(w, idle and connected)
        state(self.open_btn, connected and self.info["status"]["wifiState"] == "connected")
        self.port_box.configure(state="readonly" if idle else "disabled")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="codeshelf-setup", description=__doc__)
    parser.add_argument("--port", help="serial port to offer besides the detected ones")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args(argv)
    root = tk.Tk()
    try:
        system = root.tk.call("tk", "windowingsystem")
        ttk.Style().theme_use({"win32": "vista", "aqua": "aqua"}.get(system, "clam"))
    except tk.TclError:
        pass
    try:
        icon = tk.PhotoImage(file=os.path.join(os.path.dirname(__file__), "icon.png"))
        root.iconphoto(True, icon)
    except tk.TclError:
        pass
    SetupApp(root, args.port)
    root.mainloop()
