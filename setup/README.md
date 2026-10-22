# CodeShelf Light Setup

A small desktop app for Windows, macOS and Linux that sets up a CodeShelf Light over USB:

1. **Install firmware** on a new board, or update an existing light. The firmware is built into the app; no internet is needed.
2. **Name** the light and join your **WiFi**. The app scans for networks and checks that the light connects.
3. Optionally set a **page password** for the light's settings page.

It also restarts and factory-resets lights, and can install another firmware package (**Other firmware …**, pick its `flash.json`).

## Download

Get it from the [latest release](https://github.com/dumr666/codeshelf-light/releases/latest). The [troubleshooting guide](../docs/troubleshooting.md#setting-up) covers first-run warnings on macOS and Windows, and serial port permissions on Linux.

## Run from source

Needs Python 3.10 or newer with Tk (included with python.org installers; on Linux install `python3-tk`).

```bash
cd setup
python3 -m venv .venv && . .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python codeshelf-setup.py
```

From a checkout the app installs the firmware you built last (`firmware/.pio/build/esp32s3/package/`).
`--port <device>` adds a serial port the app does not detect on its own.

## Build a standalone app

```bash
pip install -r requirements.txt pyinstaller pillow
python build.py
```

The result is in `dist/`. PyInstaller cannot cross-compile, so build on each system; the release workflow does this on GitHub.

## Tests

```bash
python -m unittest discover -s tests -t .
```

`tests/fake_light.py` is a fake light on a pseudo terminal (Linux and macOS) that speaks the [USB protocol](../docs/protocol.md#usb-serial).
Run `python -m tests.fake_light` and start the app with `--port <printed port>` to click through the app without hardware.

## Code

| File | Purpose |
|---|---|
| `codeshelf_setup/app.py` | Tk user interface |
| `codeshelf_setup/device.py` | USB serial protocol and port detection |
| `codeshelf_setup/flasher.py` | Firmware packages and flashing with esptool |
| `build.py` | PyInstaller build |

## License

The source is MIT. Standalone builds include esptool (GPL-2.0-or-later) and are distributed under the GPL.
