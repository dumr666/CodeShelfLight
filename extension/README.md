# CodeShelf Light for VS Code

See what your AI coding agents are doing without looking at the screen.
This extension drives one or more [CodeShelf Light](https://github.com/dumr666/CodeShelfLight) RGB lights from the status of your agent sessions.

| State | Default color | When |
|---|---|---|
| Working | blue, breathing | a prompt was submitted, tools are running |
| Waiting | green | the agent finished and waits for your next prompt |
| Needs you | amber | a permission request or a question |
| Error | red | the agent stopped on an error |
| Off | off | VS Code closed, the extension disabled, or no signal |

You choose the colors, patterns and speed on the light itself (its settings page or phone app).

## Supported agents

| Agent | How the extension gets its status |
|---|---|
| Claude Code | hooks in `~/.claude/settings.json` |
| Gemini CLI | hooks in `~/.gemini/settings.json` |
| GitHub Copilot CLI | its own file, `~/.copilot/hooks/codeshelf-light.json` |
| Cursor | hooks in `~/.cursor/hooks.json` |
| Anything else | your own event → state rules ([see below](#your-own-agents)) |

The agent can run in VS Code's terminal or anywhere else on the computer. VS Code only has to be open.

## Getting started

1. Set up the light with the **CodeShelf Light Setup** app (installs the firmware and joins your WiFi).
2. Install this extension.
3. On first start the extension looks for lights on your network and adds the one it finds.
   Click **Add hooks** when it asks, or **Choose agents** to pick more than Claude Code.

Click the status bar item (`CodeShelf: working`) for the menu. Hover over it to see every light and session.

## Several lights

Add more lights with **CodeShelf Light: Add Light**. It lists the lights it finds on your network and on USB.
Each light can follow all sessions, or only some agents and projects. Use **Configure Light** or edit the setting directly:

```json
"codeshelfLight.lights": [
  { "name": "Desk", "host": "codeshelf-light-1a2b.local" },
  { "name": "Work", "host": "codeshelf-light-77c0.local", "projects": ["~/work"] },
  { "name": "Claude only", "host": "192.168.1.60", "agents": ["claude-code"] }
]
```

| Field | Default | Description |
|---|---|---|
| `name` | | Name shown in VS Code. **Rename** in Configure Light renames the light itself too |
| `host` | | Address: `<name>.local` or an IP |
| `connection` | `auto` | `auto` (WiFi, USB when WiFi does not answer), `wifi` or `usb` |
| `serialPort` | `auto` | USB port, e.g. `/dev/ttyACM0`, `/dev/cu.usbmodem101`, `COM5`. `auto` picks a free Espressif device |
| `password` | | The light's page password, if you set one. Only needed to rename the light from VS Code |
| `agents` | all | Agent ids this light follows |
| `projects` | all | Project folders this light follows: a path (`~/work`, matches everything below it), a path with `*` / `**`, or a folder name (`api`) |
| `enabled` | `true` | Turn one light off without removing it |

When several sessions match, the light shows the most important one. The order is set by `codeshelfLight.priority`, `error` › `attention` › `working` › `done` › `idle` by default.

## Answering from your phone

Claude Code only, and off by default. With `codeshelfLight.remoteAnswers` on, a permission request or an `AskUserQuestion` question shows on the Status tab of the light's web page. Tap an option (or type an answer when the question allows it) and the agent continues.

- It needs a light with a page password, set in `codeshelfLight.lights` (the light's password field) as well as on the light. Lights without one are never used, because anyone on your network could answer.
- If nobody answers within `codeshelfLight.remoteAnswerTimeout` seconds (60 by default), or the light is unreachable, the agent asks in the terminal as usual.
- Multi-select questions stay in the terminal.
- Answering `AskUserQuestion` this way passes the answers to the tool through the hook; check it with your Claude Code version before relying on it.
- Not available over USB or Bluetooth.

## Chat on your phone

The light's web page opens on a **Chat** tab (WiFi). Two switches, both off by default, both Claude Code only:

- `codeshelfLight.chatHistory`: your prompts and the agent's final answers, from every session on this computer, show up in the chat. The light keeps the last 8 messages in RAM; a restart clears them.
- `codeshelfLight.remotePrompts`: type a prompt in the chat, pick a project and send it. The extension runs it with `claude -p` in that folder and the answer comes back to the page. VS Code has to be open.

How prompts run:

- The projects on offer are the open workspace folders, the folders of recent agent sessions and `codeshelfLight.chatProjects`. Up to 8.
- `codeshelfLight.promptMode` decides how it runs. **`terminal`** (default) opens a VS Code terminal with an interactive Claude Code named after the project, so you can watch it work. The next prompt for that project is typed into the same terminal while it runs; if you closed it, `claude --continue` picks the conversation up. The answer comes back to the page through the hooks, so turn on `chatHistory` too. Approvals you do not answer on the page are asked in the terminal. **`panel`** opens the graphical Claude Code window with the prompt filled in, but Claude Code cannot be told to send it, so you press Enter yourself (it only works for folders open in this VS Code window; others use the terminal, so it suits sitting at the computer, not sending from your phone). **`background`** runs `claude -p` out of sight; tools that need approval are denied unless `remoteAnswers` is on.
- A chat continues until you tap **New chat**. It is a separate session from the Claude Code panel, which does not show it live.
- The `claude` command is the one that ships with the Claude Code extension for VS Code, then `claude` on the PATH. Set `codeshelfLight.claudePath` to use another one.
- **Anyone who knows the light's page password can make this computer run Claude Code.** Use a strong password and keep the light off untrusted networks. Like the questions, it only uses lights with a password.

## Sessions

**Show Sessions** lists every open agent session with its state. Pick one to **mute** it: a muted session no longer lights anything up, for example a long-running agent you do not want to watch. Mutes end with the session.
**Reset Session States** clears all sessions, for example after an agent crashed without saying goodbye.

## Commands

| Command | What it does |
|---|---|
| Add Light | Find lights on the network and USB, or enter an address |
| Configure Light | Rename, agents and projects to follow, connection, address, password, test, remove |
| Open Light Settings Page | Opens the light's page: colors, patterns, brightness, WiFi, firmware update |
| Choose Agents | Pick the agents that report their status; hooks follow your choice |
| Show Sessions | Open sessions; mute or unmute one |
| Test States | Sends each state to a light |
| Copy Hook Command | The hook command for an agent, to add it yourself |
| Install Hooks / Uninstall All Hooks | Manual control over hooks |
| Reset Session States | Clears stuck sessions |
| Enable/Disable | Turns all lights off and back on |

## Settings

| Setting | Default | Description |
|---|---|---|
| `codeshelfLight.lights` | `[]` | Your lights ([see above](#several-lights)) |
| `codeshelfLight.agents` | `["claude-code"]` | Agents that report their status |
| `codeshelfLight.customAgents` | `[]` | Your own agents |
| `codeshelfLight.priority` | `error, attention, working, done, idle` | Which state wins when several sessions are open |
| `codeshelfLight.codes` | `T Y R G G O` | Light state for each agent state (advanced) |
| `codeshelfLight.staleWorkingMinutes` | `15` | "Working" with no events for this long counts as done (interrupts send no event) |
| `codeshelfLight.doneToIdleMinutes` | `0` | Turn "done" into "idle" after this long (only matters with custom codes) |
| `codeshelfLight.nodePath` | `node` | Node binary in the hook command |
| `codeshelfLight.enabled` | `true` | Send status to the lights |

## Your own agents

Any tool that can run a command on an event can drive the light.
Add the agent to `codeshelfLight.customAgents` and its `id` to `codeshelfLight.agents`:

```json
"codeshelfLight.customAgents": [
  {
    "id": "my-agent",
    "name": "My Agent",
    "events": {
      "start": "working",
      "ask": "attention",
      "finish": "done",
      "crash": "error",
      "exit": "end",
      "notify": { "by": "type", "cases": { "permission": "attention" }, "default": "done" }
    }
  }
],
"codeshelfLight.agents": ["claude-code", "my-agent"]
```

Then have the agent run `node ~/.codeshelf/light/hook.js my-agent <event>`. **Copy Hook Command** puts it on the clipboard.
The hook reads the agent's JSON from stdin, if there is any, and tells sessions apart by `session_id`, `sessionId` or `conversation_id`.
You can also pass a state directly: `node ~/.codeshelf/light/hook.js my-agent working`. The states are `working`, `attention`, `error`, `done`, `idle` and `end`.

If the agent uses one of the known hook formats, add `"format": "claude" | "cursor" | "copilot"` and `"file": "<settings file>"`, and the extension installs the hooks for you.
If the agent expects output on stdout, set `"stdout": { "default": "{}" }`.

## How it works

```
agent ──hook──▶ ~/.codeshelf/light/hook.js <agent> <event>
                    │ maps the event to a state (rules in ~/.codeshelf/light/agents.json)
                    ▼
        ~/.codeshelf/light/sessions/<agent>--<session>.json
                    │ the extension watches this folder
                    ▼
        VS Code extension ──WiFi (HTTP) or USB serial──▶ lights
```

All agents share one small hook script that only writes a file, so it never slows an agent down.
The extension installs hooks for the agents you select and removes them when you deselect one.
Before it changes a settings file it saves `<file>.codeshelf.bak`, and it never touches other hooks in that file.
Nothing leaves your computer except the state letter sent to your lights.

## Limitations

- **Amber stays on while an approved tool runs.** No hook fires on approval; the state changes when the tool finishes.
- **Blue stays on after you interrupt an agent.** Interrupts fire no hook, so the light reads the end of the session's transcript (Claude Code) and turns green within a second. Agents without a transcript fall back to `staleWorkingMinutes`.
- **Cursor has no permission hook,** so "needs you" never shows for Cursor.
- **Codex CLI is not a preset.** Its `notify` fires only when a turn completes; add it as a custom agent with one `done` event.
- **The Gemini CLI and Copilot CLI presets** follow their published hook documentation.
- **USB on Windows** finds the port through PowerShell and is less tested than WiFi.

## Troubleshooting

1. **Do the hooks write state?** `~/.codeshelf/light/sessions/` should hold a file while an agent works.
2. **Can the extension reach the light?** Hover over the status bar item; **Show Log** lists connection errors.
3. **Does the light respond?** `curl 'http://<light>.local/set?c=Y'` turns it amber.

More in the [troubleshooting guide](https://github.com/dumr666/CodeShelfLight/blob/main/docs/troubleshooting.md).
