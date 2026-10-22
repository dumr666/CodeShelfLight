# Contributing

Issues and pull requests are welcome. For bigger changes, open an issue first so we can agree on the approach.

## Repository layout

| Folder | Language | Test |
|---|---|---|
| `firmware/` | C++ (PlatformIO, Arduino) | `pio run` must build without warnings from our code; the page has a mock: `python3 web/mock_device.py` |
| `extension/` | JavaScript (no dependencies, no build step) | `npm test` |
| `setup/` | Python 3.10+ with Tk | `python -m unittest discover -s tests -t .` |

CI runs all three on every pull request.

## Style

- Match the code around you. Comments explain *why*, in plain English.
- The extension has no runtime dependencies on purpose; keep it that way.
- The firmware's interfaces are public. Change them in a backwards-compatible way and update [docs/protocol.md](docs/protocol.md).
- A new state touches the firmware (`config.cpp`), the page (`web/index.html`) and the extension (`DEFAULT_CODES`).

## Testing on hardware

1. Flash: `cd firmware && pio run -t upload`.
2. Set up WiFi with the setup app from source: `cd setup && python codeshelf-setup.py`.
3. Install the extension: `cd extension && npm run package && code --install-extension codeshelf-light-*.vsix --force`, then **Developer: Reload Window**.

## Releasing

1. Bump the version in `firmware/include/app.h` (`FW_VERSION`), `extension/package.json` and `setup/codeshelf_setup/__init__.py`, and add a section to `CHANGELOG.md`.
2. Tag and push: `git tag v1.2.3 && git push origin v1.2.3`.
3. The release workflow builds the firmware, the extension and the setup app for Windows, macOS and Linux, and drafts a GitHub release. Check it and publish.
