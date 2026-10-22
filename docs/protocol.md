# Protocol

Everything the light understands, so you can drive it from scripts, other editors or home automation.
The VS Code extension, the setup app and the settings page use exactly these interfaces.

## States

| Code | Key | Meaning | Default look |
|---|---|---|---|
| `T` | `working` | the agent works | blue, breathing |
| `G` | `waiting` | the agent waits for a prompt | green |
| `Y` | `attention` | the agent needs you | amber |
| `R` | `error` | the agent stopped on an error | red |
| `O` | `off` | nothing to show | off |

Purple means a firmware update is running.

A state sent by the extension (WiFi or USB) expires: with no new command for `timeout` seconds (off by default; 0 = never) the light turns off.
The extension repeats the current state every 5 seconds, so this only happens when the computer sleeps or VS Code closes.
States set by hand (settings page with `manual=1`, Bluetooth) do not expire.

## Settings JSON

`GET /config`, the Bluetooth settings characteristic and the USB `info` command return:

```json
{"name":"CodeShelf Light 1A2B","host":"codeshelf-light-1a2b","wifi":true,"ble":true,"ssid":"Home","auth":false,
 "brightness":64,"timeout":0,"fade":600,
 "states":{"working":["#0000ff","breathe",2600],"waiting":["#00ff00","solid",2000],
           "attention":["#ff4600","solid",1200],"error":["#ff0000","solid",1000],"off":["#000000","solid",1000]}}
```

| Key | Type | Description |
|---|---|---|
| `name` | 1-29 characters | Display name and Bluetooth name. `host` is derived from it |
| `host` | read only | `<host>.local` is the light's address |
| `wifi`, `ble` | bool | Radios on or off; at least one stays on |
| `ssid` | ≤ 32 characters | WiFi network |
| `auth` | read only | Whether a page password is set |
| `brightness` | 0-255 | |
| `timeout` | 0-3600 s | Turn off without commands for this long; 0 = never |
| `fade` | 0-5000 ms | Fade between states |
| `states.<key>` | `[color, pattern, period]` | `#rrggbb`; `solid`, `breathe`, `blink`, `double`, `flash` or `rainbow`; one cycle in ms (200-10000) |

To change settings, send a partial object with only the keys you change. These keys are write-only:

| Key | Description |
|---|---|
| `wifiPassword` | 8-63 characters, or empty for an open network. Setting `ssid` without it means an open network |
| `adminPassword` | Page password (user `admin`), ≤ 63 characters; empty removes it |
| `preview` | A state key: show it for 15 s without changing the mode (the settings page uses this while you edit). `""` ends it |

Invalid values are rejected as a whole with an error message.
Changing `name`, `wifi` or `ble` restarts the light (the answer says `"reboot": true`).
New WiFi credentials apply without a restart.
Settings are written to flash 2 s after the last change.

## HTTP

The light listens on port 80 at `http://<host>.local/` (or its IP).

| Request | Auth | Description |
|---|---|---|
| `GET /set?c=T` or `/set?s=working` | open | Set the state. `&manual=1` exempts it from the timeout |
| `GET /status` | open | Status JSON (below) |
| `GET /brightness?v=0..255` | open | Set the brightness |
| `GET /` | password | Settings page |
| `GET /config` | password | Settings JSON |
| `POST /config` | password | Partial settings JSON. `200 {"reboot":bool,"config":{…}}` or `400 {"error":"…"}` |
| `GET /scan` | password | WiFi networks: `202` while scanning, then `200 [{"ssid","rssi","secure"}]` |
| `POST /ask` | password | Show a question on the page (below). `200 {"id":N}` |
| `GET /ask` | password | The current question, with `answer` once answered. `{"id":0}` when there is none |
| `POST /answer` | password | `{"id":N,"answer":"…"}` from the page. `409` if the question is gone or already answered |
| `POST /ask/clear` | password | Remove the question |
| `GET /chat?after=ID` | password | Chat projects and messages newer than `ID` (below) |
| `POST /chat` | password | `{"text","project","newChat"}` from the page: a prompt for the extension. `409` while one is still running |
| `POST /chat/next` | password | The extension takes the waiting prompt: `{"id","project","text","newChat"}` or `{"id":0}` |
| `POST /chat/done` | password | The prompt is finished |
| `POST /chat/msg` | password | `{"role":"user\|assistant\|note","project","text"}` adds a message |
| `POST /chat/projects` | password | `{"projects":["name",…]}` the folders the page may pick |
| `POST /chat/clear` | password | Clear the history |
| `POST /reboot` | password | Restart |
| `POST /update` | password | Firmware upload (`multipart/form-data`, field `firmware`) |

"Password" applies only when a page password is set: HTTP Basic auth, user `admin`.
Send `POST /config` with `Content-Type: application/json` (or `text/plain`):

```bash
curl -H 'Content-Type: application/json' -d '{"brightness":128}' http://codeshelf-light-1a2b.local/config
```

### Questions

The extension's hook (Claude Code) can put a question on the light's page so you can answer from your phone:

```json
POST /ask   {"title":"Allow Bash?","text":"npm test","options":["Allow","Deny"],"free":false,"ttl":60}
```

`options` holds up to 6 labels (≤ 60 characters); with `free: true` the page also takes typed text.
`title` ≤ 80, `text` ≤ 400 characters, `ttl` 5-600 s (default 90). One question at a time; a new one replaces the old.
The page polls `GET /ask` and shows it on the Status tab. The hook polls the same endpoint until `answer` appears, then calls `POST /ask/clear`.
Questions are kept in RAM only. These endpoints need the page password when one is set, and the extension only uses lights that have one.

### Chat

The page's Chat tab sends a prompt with `POST /chat`; the extension polls `POST /chat/next`, runs `claude -p` in the folder behind the project name (the light only ever sees names, never paths), posts the answer with `POST /chat/msg` and calls `POST /chat/done`. The hook posts your prompts and the agents' final answers with `POST /chat/msg` too (`codeshelfLight.chatHistory`).

```json
GET /chat?after=12   {"seq":14,"running":false,"projects":["app","tool"],"msgs":[{"id":13,"role":"user","project":"app","text":"…"},{"id":14,"role":"assistant","project":"app","text":"…"}]}
```

Message ids only grow; a `seq` lower than the one you saw means the light restarted. History is the last 8 messages of up to 2500 characters, in RAM only. One prompt at a time, freed after 20 minutes if nobody finishes it.

Status JSON:

```json
{"mode":"T","state":"working","name":"CodeShelf Light 1A2B","host":"codeshelf-light-1a2b","wifi":true,"ble":true,
 "wifiState":"connected","ssid":"Home","ip":"192.168.1.50","rssi":-52,"mac":"AA:BB:CC:DD:1A:2B","bleClients":0,
 "brightness":64,"lastCommandAgo":2,"source":"wifi","uptime":3600,"heap":200000,"version":"1.0.0","build":"…"}
```

`wifiState` is `connected`, `connecting`, `wrong-password`, `not-found`, `unconfigured` or `off`.
`source` is where the last state came from: `wifi`, `usb`, `ble`, `web` (by hand) or `-`.

## USB serial

The board shows up as a USB serial port (Espressif, VID `303A`): `/dev/ttyACM*` on Linux, `/dev/cu.usbmodem*` on macOS, `COMx` on Windows.
The baud rate does not matter.

**States:** write a single state code (`T`, `G`, `Y`, `R`, `O`). No line ending is needed; other bytes are ignored.

**Requests:** write one JSON object per line. The light answers with one JSON line with the same `id`.
Other lines on the port (boot messages, logs) are not JSON objects with your `id`; skip them.

```
→ {"id":1,"cmd":"info"}
← {"id":1,"ok":true,"status":{…},"config":{…}}
→ {"id":2,"cmd":"set","config":{"ssid":"Home","wifiPassword":"secret123"}}
← {"id":2,"ok":true,"reboot":false,"config":{…}}
→ {"id":3,"cmd":"set","config":{"fade":99999,"wifiPassword":"short"}}
← {"id":3,"ok":false,"error":"WiFi password must be 8-63 characters"}
```

| `cmd` | Answer |
|---|---|
| `info` | `status` and `config` |
| `set` | Applies `config` (same keys as `POST /config`); `reboot` and the new `config` |
| `scan` | `networks`: `[{"ssid","rssi","secure"}]`, after a few seconds |
| `reboot` | `ok`, then restarts |
| `factory-reset` | `ok`, then erases all settings and restarts |

USB needs no password: whoever can plug in the light owns it.

Opening the port with DTR and RTS both asserted (most tools' default) does not reset the board.
Asserting RTS alone resets it; that is how esptool enters the bootloader.

## Bluetooth LE

The light advertises under its name with service `c1a0de00-0000-4000-8000-000000000000`.
Values are UTF-8 text, so generic apps (LightBlue, nRF Connect) can read and write them.

| UUID | Name | Access | Value |
|---|---|---|---|
| `c1a0de01-…` | Mode | read, write, notify | a state code |
| `c1a0de02-…` | Brightness | read, write, notify | `"0"`-`"255"`, or one raw byte |
| `c1a0de03-…` | Settings | read, write | settings JSON; write a partial object. An invalid write is ignored and the value resets |
| `c1a0de04-…` | Status | read | status JSON |
| `c1a0de05-…` | Command | write | `reboot` |

(`…` is `-0000-4000-8000-000000000000`.)
States set over Bluetooth count as set by hand and do not expire.
Bluetooth has no pairing or password; anyone in range can change the light, as with most desk gadgets.
Turn Bluetooth off in the settings if that matters to you.

## mDNS

With WiFi connected the light announces:

- `<host>.local`, its address
- `_http._tcp` and `_codeshelf._tcp` on port 80, with TXT records `name` and `version`

`dns-sd -B _codeshelf._tcp` (macOS) or `avahi-browse -rt _codeshelf._tcp` (Linux) lists the lights on your network.
The extension's **Add Light** uses the same service.
