# Firmware

The firmware runs on an ESP32-S3 and is built with [PlatformIO](https://platformio.org/) (Arduino framework).
Most people never build it: the [setup app](../setup/README.md) ships a released firmware and installs it over USB.

## Building and flashing

```bash
cd firmware
pio run                        # build
pio run -t upload              # build and flash over USB
pio device monitor             # serial log
```

The first flash goes over USB. If the board does not show up, hold **BOOT**, press **RESET**, release **BOOT**, and try again.

Each build also writes `.pio/build/esp32s3/package/`: the flash images and a `flash.json` manifest.
The setup app can install that folder (**Other firmware …**), and the release workflow zips it.

### Updating over WiFi

Once the light is on your WiFi there are three ways to update it without a cable:

- **Settings page:** Settings → Firmware update, choose `firmware.bin` from a release.
- **PlatformIO (OTA):** `pio run -e ota -t upload --upload-port codeshelf-light-1a2b.local`. With a page password set, add `upload_flags = --auth=<password>` to the `ota` environment.
- **curl:** `curl -F firmware=@firmware.bin http://codeshelf-light-1a2b.local/update`

Settings live in their own flash partition (NVS) and survive updates.

### WiFi for development

The setup app, the Bluetooth app or the settings page set WiFi at runtime.
To skip that during development, copy `include/secrets.h.example` to `include/secrets.h` and fill it in.
Those values apply until WiFi is set another way; `secrets.h` is ignored by git and not used for releases.

## Settings page

`web/index.html` is a single page, styled like iOS settings, with three tabs:

- **Status:** current state, brightness, set a state by hand
- **Lights:** color, pattern and speed for each state, fade time, turn-off timeout. Changes apply as you make them, and the light previews the state you are editing
- **Settings:** name, WiFi on/off and network, Bluetooth on/off, page password, device info, firmware update, restart

The build gzips it into the firmware (`scripts/embed_web.py` → `include/webpage.h`).
To work on the page without hardware, run the mock light and open http://127.0.0.1:8765/:

```bash
python3 web/mock_device.py
```

## Bluetooth app

The same `web/index.html`, opened from anywhere other than the light, connects over Web Bluetooth instead of HTTP.
That is useful for a light that is not on WiFi yet, or has WiFi turned off.

- **Android, Windows, macOS, Linux:** Chrome or Edge.
- **iPhone / iPad:** Safari has no Web Bluetooth; use the free [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) browser.

The page has to be served over HTTPS. This repository publishes it to GitHub Pages: https://dumr666.github.io/codeshelf-light/

## Code

| File | Purpose |
|---|---|
| `src/main.cpp` | Setup, main loop, state commands, status JSON |
| `src/config.cpp` | Settings: defaults, JSON, flash storage |
| `src/led.cpp` | Patterns, fades, preview |
| `src/net.cpp` | WiFi connection and state, network scan, mDNS, OTA |
| `src/web.cpp` | HTTP server |
| `src/ble.cpp` | Bluetooth LE service |
| `src/usb.cpp` | USB serial: state codes and JSON requests |
| `web/index.html` | Settings page and Bluetooth app |
| `web/mock_device.py` | Fake light for working on the page |
| `scripts/embed_web.py` | Embeds the page before each build |
| `scripts/package.py` | Writes the flash package after each build |

The interfaces are documented in [protocol.md](protocol.md).
When you add or change a state, update `config.cpp` (`STATE_*`), `web/index.html` (`STATES`) and the extension (`DEFAULT_CODES`).
