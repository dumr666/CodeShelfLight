# PlatformIO post-build: collect the flash images and a manifest into .pio/build/<env>/package/.
# The setup app flashes from this folder; the release workflow zips it.
import json
import os
import re
import shutil

Import("env")  # noqa: F821


def package(source, target, env):
    build = env.subst("$BUILD_DIR")
    out = os.path.join(build, "package")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)

    images = [(offset, path) for offset, path in env.get("FLASH_EXTRA_IMAGES", [])]
    images.append((env.subst("$ESP32_APP_OFFSET"), os.path.join(build, env.subst("${PROGNAME}.bin"))))
    parts = []
    for offset, path in images:
        path = env.subst(path)
        name = os.path.basename(path)
        shutil.copy(path, os.path.join(out, name))
        parts.append({"offset": offset, "file": name})

    app_h = open(os.path.join(env.subst("$PROJECT_DIR"), "include", "app.h")).read()
    version = re.search(r'#define FW_VERSION "([^"]+)"', app_h).group(1)
    board = env.BoardConfig()
    manifest = {
        "name": "CodeShelf Light",
        "version": version,
        "chip": board.get("build.mcu"),
        # The mode esptool writes into the bootloader header. Like PlatformIO, use dio for qio/qout
        # boards: the ROM loads the bootloader in dio and the bootloader switches to qio itself.
        "flashMode": env.subst("${__get_board_flash_mode(__env__)}"),
        "flashFreq": env.subst("${__get_board_f_flash(__env__)}"),
        "flashSize": board.get("upload.flash_size", "4MB"),
        "parts": parts,
    }
    with open(os.path.join(out, "flash.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"package: {out} (firmware {version})")


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", package)  # noqa: F821
