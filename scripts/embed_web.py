# PlatformIO pre-build: web/index.html -> include/webpage.h (gzip, PROGMEM)
# The same web/index.html is also the BLE app when opened from another address (e.g. in Bluefy).
import gzip
import os

Import("env")  # noqa: F821

root = env.subst("$PROJECT_DIR")  # noqa: F821
src = os.path.join(root, "web", "index.html")
dst = os.path.join(root, "include", "webpage.h")

with open(src, "rb") as f:
    data = gzip.compress(f.read(), compresslevel=9, mtime=0)

body = ",".join(str(b) for b in data)
header = (
    "// Generated from web/index.html (scripts/embed_web.py). Do not edit by hand.\n"
    "#pragma once\n#include <Arduino.h>\n\n"
    f"const uint8_t INDEX_HTML_GZ[] PROGMEM = {{{body}}};\n"
    f"const size_t INDEX_HTML_GZ_LEN = {len(data)};\n"
)

old = open(dst).read() if os.path.exists(dst) else ""
if old != header:
    with open(dst, "w") as f:
        f.write(header)
    print(f"embed_web: {src} -> {dst} ({len(data)} B gzip)")
