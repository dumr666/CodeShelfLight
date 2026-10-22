# Changelog

## 1.0.0

First public release.

### Firmware
- States working, waiting, attention, error and off, each with its own color, pattern (solid, breathe, blink, double blink, flash, rainbow) and speed, with smooth fades.
- Settings page styled like iOS settings, for phones and desktops. Changes apply as you make them, and the light previews the state you are editing.
- WiFi set at runtime from the setup app, the Bluetooth app or the settings page, with network scan and connection state (wrong password, network not found).
- HTTP API, USB serial protocol (state codes and JSON requests), Bluetooth LE service, mDNS service `_codeshelf._tcp`.
- Unique default name per light (`CodeShelf Light 1A2B`), optional page password, OTA updates, factory reset.
- Chat tab (first page): prompts typed on the page run on the computer through the extension, and the page shows the agents' final answers as a chat history.
- Questions from the agent show on the page (Status tab) with buttons or a text field, so you can answer from your phone.

### VS Code extension
- Presets for Claude Code, Gemini CLI, GitHub Copilot CLI and Cursor, plus your own agents.
- Several lights, each following all sessions or only some agents and projects.
- Finds lights on the network and USB; adds the first one automatically.
- Muting sessions, configurable state priority.
- Optional `remotePrompts` (run prompts typed on the light's Chat tab in a VS Code terminal, in the Claude Code window (you press Enter), or with `claude -p` via `promptMode`) and `chatHistory` (your prompts and the agents' final answers on the Chat tab), both off by default.
- Optional `remoteAnswers` (Claude Code, off by default): permission requests and `AskUserQuestion` go to the light's page; the terminal asks as usual if nobody answers in time.

### Setup app
- Windows, macOS and Linux app that installs the firmware and sets up name, WiFi and password over USB.
