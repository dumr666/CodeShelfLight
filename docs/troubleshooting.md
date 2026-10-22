# Troubleshooting

## Setting up

### The setup app does not find the light

- Use a **data** USB cable. Many USB-C cables only charge.
- Try another USB port, and avoid unpowered hubs.
- Tick **Show all serial ports** in the app.
- A brand-new board sometimes needs the bootloader started by hand: hold **BOOT**, press and release **RESET**, release **BOOT**, then **Refresh** and **Install firmware**.
- Close other programs that use the port: a serial monitor, Arduino IDE, PlatformIO, or the VS Code extension set to USB.

### Linux: permission denied on the serial port

Add yourself to the group that owns serial ports, then log out and back in:

```bash
sudo usermod -aG dialout $USER     # Debian, Ubuntu
sudo usermod -aG uucp $USER        # Arch
```

On Fedora `dialout` works as well.

### macOS: "cannot be opened because the developer cannot be verified"

The app is not notarized. Right-click it, choose **Open**, then **Open** again. You only need to do this once.

### Windows: SmartScreen warns about the app

The app is not code-signed. Click **More info → Run anyway**.

### WiFi: "Wrong password" or "Network not found"

- The ESP32 only supports **2.4 GHz** WiFi. On a dual-band router, make sure 2.4 GHz is on; one network name for both bands is fine.
- Network names and passwords are case-sensitive.
- Enterprise WiFi (WPA2-Enterprise, captive portals as in hotels or offices) is not supported. Use a phone hotspot or the USB connection.

## Using it

### The light does not react to the agent

1. **Do the hooks write state?** While an agent works, `~/.codeshelf/light/sessions/` (on Windows `%USERPROFILE%\.codeshelf\light\sessions\`) holds a file for its session. If not, run **CodeShelf Light: Install Hooks** and start a *new* agent session; running sessions keep their old hooks.
2. **Can VS Code reach the light?** Hover over the CodeShelf item in the status bar. **CodeShelf Light: Show Log** lists connection errors.
3. **Does the light respond?** `curl 'http://<name>.local/set?c=Y'` should turn it amber.

### `<name>.local` does not resolve

- **Windows:** `.local` names work on Windows 10 1903 and later. On older systems, or if your network blocks multicast, use the IP address. The setup app and the settings page (Settings → About) show it.
- **Linux:** install and start Avahi with `nss-mdns` (`sudo apt install avahi-daemon libnss-mdns`).
- **Guest or mesh networks** often block devices from seeing each other. Put the computer and the light on the same network.
- Give the light a fixed IP in your router (DHCP reservation) and use the IP in the extension.

### The light turns off after 30 seconds

It has not heard from the extension. Is VS Code open and the extension enabled? Check the log as above.
You can change or disable the timeout on the light (Lights → Turn off without signal).

### The light stays blue after I stopped the agent

Interrupting an agent fires no hook, so the session still looks busy.
After `codeshelfLight.staleWorkingMinutes` (15 by default) it counts as done. **Reset Session States** clears it right away.

### Amber stays on after I approved a tool

No hook fires on approval. The light changes when the tool finishes.

### I forgot the page password

Factory-reset the light from the setup app over USB, or set a new password there; USB needs no password.

## Developing

### OTA upload fails with "No response from the ESP"

- Set the PlatformIO upload port to the light (`--upload-port <name>.local`), not a serial port.
- With a page password, add `upload_flags = --auth=<password>` to the `ota` environment.
- A firewall on your computer may block the light connecting back for the upload.
