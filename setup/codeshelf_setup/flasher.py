"""Flashing the CodeShelf Light firmware with esptool.

A firmware package is a folder with flash.json and the images it lists. The firmware build writes it
to firmware/.pio/build/esp32s3/package/; releases bundle it into the app.
Settings (WiFi, name, colors) live in their own flash partition and survive a flash.
"""
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import esptool
from esptool.logger import TemplateLogger, log


@dataclass
class Package:
    folder: Path
    version: str
    chip: str
    flash_mode: str
    flash_freq: str
    flash_size: str
    parts: list  # [(offset, Path)]

    @property
    def total_size(self):
        return sum(p.stat().st_size for _, p in self.parts)


def load_package(folder):
    folder = Path(folder)
    manifest = json.loads((folder / "flash.json").read_text())
    parts = []
    for part in manifest["parts"]:
        path = folder / part["file"]
        if not path.is_file():
            raise FileNotFoundError(f"{path} is missing")
        parts.append((part["offset"], path))
    return Package(folder, manifest["version"], manifest["chip"], manifest["flashMode"], manifest["flashFreq"],
                   manifest["flashSize"], parts)


def bundled_package():
    """The firmware shipped with the app, or the local build when running from the repository."""
    here = Path(__file__).resolve().parent
    candidates = [
        Path(getattr(sys, "_MEIPASS", here)) / "firmware",
        here / "firmware",
        here.parent.parent / "firmware" / ".pio" / "build" / "esp32s3" / "package",
    ]
    for folder in candidates:
        if (folder / "flash.json").is_file():
            return load_package(folder)
    return None


class _Progress(TemplateLogger):
    """Turns esptool's per-image progress bars into one overall fraction."""

    def __init__(self, sizes, on_progress, on_message):
        self.sizes = sizes
        self.on_progress = on_progress
        self.on_message = on_message
        self.index = -1
        self.last = None
        self.total = None

    def print(self, *args, **kwargs):
        text = " ".join(str(a) for a in args).strip()
        if text:
            self.on_message(text)

    def note(self, message):
        self.on_message(message)

    def warning(self, message):
        self.on_message(message)

    def error(self, message):
        self.on_message(message)

    def stage(self, finish=False):
        pass

    def set_verbosity(self, verbosity):
        pass

    def progress_bar(self, cur_iter, total_iters, prefix="", suffix="", bar_length=30):
        if not total_iters:
            return
        # A new bar starts for every image; totals are compressed sizes, so only the share per image is used
        if total_iters != self.total or cur_iter < self.last:
            self.index = min(self.index + 1, len(self.sizes) - 1)
        self.last = cur_iter
        self.total = total_iters
        done = sum(self.sizes[: self.index]) + self.sizes[self.index] * cur_iter / total_iters
        self.on_progress(done / sum(self.sizes))


def flash(port, package, on_progress=lambda f: None, on_message=lambda m: None):
    """Write the package to the device on port. Raises RuntimeError on failure."""
    args = [
        "--chip", package.chip, "--port", port, "--baud", "460800",
        "--before", "default-reset", "--after", "hard-reset",
        "write-flash", "--flash-mode", package.flash_mode, "--flash-freq", package.flash_freq,
        "--flash-size", package.flash_size,
    ]
    for offset, path in package.parts:
        args += [offset, os.fspath(path)]
    log.set_logger(_Progress([p.stat().st_size for _, p in package.parts], on_progress, on_message))
    try:
        esptool.main(args)
    except SystemExit as e:
        if e.code:
            raise RuntimeError(f"esptool exited with {e.code}") from None
    except Exception as e:  # esptool raises FatalError and serial errors with useful messages
        raise RuntimeError(str(e)) from e
    on_progress(1.0)
