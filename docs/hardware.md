# Hardware

## Parts

| Part | Notes |
|---|---|
| [Waveshare ESP32-S3-Zero](https://www.waveshare.com/esp32-s3-zero.htm) | ESP32-S3 with 4 MB flash and a WS2812 RGB LED on GPIO21. About €5. The variant without pin headers fits small enclosures |
| USB-C cable | A **data** cable. Charge-only cables power the board but the computer does not see it |

That is the whole light. It runs from any USB port or phone charger; it only needs the computer's USB port when you set it up over USB or use the USB connection instead of WiFi.

## Making it glow nicely

The on-board LED is tiny and very bright. Put something translucent over it:

- a ping-pong ball with a hole, or a frosted glass or acrylic cube
- a 3D-printed shade in white PLA, 0.8-1.2 mm walls
- a piece of paper towel inside a small jar

Lower the brightness on the settings page if it is too much; 30-60 out of 255 is plenty on a desk.

## Other boards

Any ESP32-S3 board with a WS2812 / SK6812 LED (or a strip) works. Set the data pin in `firmware/platformio.ini`:

```ini
build_flags =
	...
	-DLED_PIN=48     ; e.g. ESP32-S3-DevKitC-1 v1.0
	-DLED_COUNT=1
```

| Board | `LED_PIN` |
|---|---|
| Waveshare ESP32-S3-Zero | 21 (default) |
| Espressif ESP32-S3-DevKitC-1 v1.0 | 48 |
| Espressif ESP32-S3-DevKitC-1 v1.1 | 38 |

Boards with 8 MB or more flash work with the default settings too.
Other ESP32 chips (ESP32, ESP32-C3) need a different `board` in `platformio.ini` and a USB-serial chip for the USB connection; they are not tested.

## LED strips

With `-DLED_COUNT=12` the firmware drives 12 LEDs in the same color, for example a ring behind your monitor.
Power strips longer than a few LEDs from 5 V directly (not through the board's 3.3 V pin), share ground with the board, and keep the brightness reasonable: USB ports give about 500 mA, which is roughly 10 LEDs at full white.
