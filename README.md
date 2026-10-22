# CodeShelf Light: firmware

Firmware for the CodeShelf Light, an ESP32-S3 Zero with one WS2812 RGB LED on GPIO21.
The light shows the state of an AI coding agent. The CodeShelf Light VSCode extension sends it the state over WiFi, USB or Bluetooth.

## Setup

1. Copy `include/secrets.h.example` to `include/secrets.h` and fill in your WiFi. The ESP32 supports 2.4 GHz networks only.
   `secrets.h` is in `.gitignore`.
2. The first flash goes over USB:
   ```bash
   pio run -e esp32-s3-devkitc-1 -t upload
   ```
3. Every later flash goes over WiFi:
   ```bash
   pio run -e ota -t upload
   ```
   If you rename the light, update `upload_port` in `platformio.ini`.
   In VSCode, set the PlatformIO port to **Auto**. Otherwise PlatformIO passes the serial port and OTA fails.

The light starts as **CodeShelf Light** at `http://codeshelf-light.local/`.

## Settings page and app

`web/index.html` is a single page styled like iOS settings, with three tabs:

- **Status**: the current state, brightness, and manual state selection
- **Lights**: color, pattern (solid, breathe, blink, double blink, flash, rainbow), speed and fade for each state, and when to turn off without a signal
- **Settings**: name, WiFi and Bluetooth on/off, device info, firmware upload, reboot

The same file works over WiFi and over Bluetooth:

- **WiFi**: open `http://<name>.local/`. The build embeds the page into the firmware (`scripts/embed_web.py` → `include/webpage.h`, gzipped).
  On iPhone you can use **Share → Add to Home Screen** to get an app icon.
- **Bluetooth**: open `web/index.html` from any HTTPS address, for example GitHub Pages.
  Safari does not support Web Bluetooth, so on iPhone open it in the **Bluefy** app. On Android or desktop, use Chrome.
  The page sees that it was not served by the light and offers to connect over Bluetooth.

Colors, patterns, speed, fade and brightness apply as you change them, with no save button.
While you edit a state, the light previews it.
The light writes settings to flash 2 s after the last change, so dragging a slider does not wear it out.

Changing the name, WiFi or Bluetooth restarts the light.
At least one of WiFi and Bluetooth stays on. USB always works.

## States

| Code | State | Default |
|---|---|---|
| `T` | working | blue, breathing |
| `G` | waiting | green |
| `Y` | attention (needs you) | amber |
| `R` | error | red |
| `O` | off | off |

Purple means a firmware update is in progress.
Colors fade into each other over the fade time, 0.6 s by default.
If the extension sends nothing for the timeout (30 s by default), the light turns off.
States set by hand from the page or over Bluetooth stay until something changes them.

## HTTP API

| Request | Description |
|---|---|
| `GET /set?c=T` or `/set?s=working` | Set the state. Add `manual=1` to exempt it from the timeout |
| `GET /status` | JSON: state, name, IP, RSSI, Bluetooth clients, brightness, last command, version |
| `GET /config` | JSON settings |
| `POST /config` | Partial JSON settings, for example `{"fade":800}`. Returns `{"reboot":bool,"config":{…}}` or `400 {"error":…}`.<br>`"preview":"working"` shows that state on the light for 15 s without changing the mode. `"preview":""` ends it |
| `GET /brightness?v=0..255` | Set brightness |
| `POST /reboot` | Restart |
| `POST /update` | Firmware upload (multipart) |

Send `POST /config` as JSON or plain text: `curl -H 'Content-Type: application/json' -d '{"fade":800}' …`.
The settings JSON stores states as `[color, pattern, period ms]`:

```json
{"name":"CodeShelf Light","host":"codeshelf-light","wifi":true,"ble":true,"brightness":32,"timeout":30,"fade":600,
 "states":{"working":["#0000ff","breathe",2600],"waiting":["#00ff00","solid",2000],"attention":["#ff4600","solid",1200],
           "error":["#ff0000","solid",1000],"off":["#000000","solid",1000]}}
```

To protect the page, settings, firmware upload and reboot, add `#define OTA_PASSWORD "..."` to `secrets.h` (user `admin`).
Then add `upload_flags = --auth=<password>` to the `ota` env.
`/set` and `/status` stay open so the extension can reach them.

## Bluetooth (BLE)

The device advertises under its name. All values are UTF-8 text, so you can read and write them in LightBlue or nRF Connect.

| UUID | Name | Access |
|---|---|---|
| `c1a0de00-0000-4000-8000-000000000000` | service | |
| `c1a0de01-…` | Mode (T/G/Y/R/O) | read, write, notify |
| `c1a0de02-…` | Brightness (0-255) | read, write, notify. Accepts text or a single raw byte |
| `c1a0de03-…` | Settings (JSON) | read, write. Same as `/config`. An invalid write is rejected and the value resets |
| `c1a0de04-…` | Status (JSON) | read |
| `c1a0de05-…` | Command (reboot) | write |

## Code

| File | Purpose |
|---|---|
| `src/main.cpp` | Setup, loop, commands, status, WiFi and OTA |
| `src/config.cpp` | Settings: defaults, JSON, NVS storage |
| `src/led.cpp` | Patterns and fades |
| `src/web.cpp` | HTTP server |
| `src/ble.cpp` | BLE service |
| `web/index.html` | Settings page and BLE app |
| `scripts/embed_web.py` | Embeds the page into `include/webpage.h` before each build |
