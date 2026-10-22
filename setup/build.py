#!/usr/bin/env python3
"""Build a standalone CodeShelf Light Setup app for this OS with PyInstaller.

    pip install -r requirements.txt pyinstaller
    python build.py [--firmware ../firmware/.pio/build/esp32s3/package]

Output: dist/codeshelf-setup (Linux), dist/codeshelf-setup.exe (Windows), dist/CodeShelf Light Setup.app (macOS).
The firmware package is bundled, so the app can install it without a download.
"""
import argparse
import os
import sys
from pathlib import Path

import PyInstaller.__main__

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--firmware", default=HERE.parent / "firmware" / ".pio" / "build" / "esp32s3" / "package",
                        type=Path, help="firmware package folder (with flash.json)")
    args = parser.parse_args()
    if not (args.firmware / "flash.json").is_file():
        sys.exit(f"No firmware package in {args.firmware}. Build the firmware first: cd ../firmware && pio run")

    mac = sys.platform == "darwin"
    icon = []  # Linux binaries have no icon; macOS converts the PNG with Pillow
    if sys.platform == "win32":
        icon = ["--icon", str(HERE / "icon.ico")]
    elif mac:
        icon = ["--icon", str(HERE / "codeshelf_setup" / "icon.png")]
    PyInstaller.__main__.run([
        str(HERE / "codeshelf-setup.py"),
        "--name", "CodeShelf Light Setup" if mac else "codeshelf-setup",
        "--onedir" if mac else "--onefile",  # macOS wants an .app bundle; elsewhere one file is simplest
        "--windowed",
        "--noconfirm",
        "--clean",
        "--paths", str(HERE),
        "--collect-data", "esptool",  # flasher stubs
        "--collect-submodules", "esptool",
        "--add-data", f"{args.firmware}{os.pathsep}firmware",
        "--add-data", f"{HERE / 'codeshelf_setup' / 'icon.png'}{os.pathsep}codeshelf_setup",
        "--osx-bundle-identifier", "dev.codeshelf.light.setup",
    ] + icon)


if __name__ == "__main__":
    main()
