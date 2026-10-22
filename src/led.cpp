// LED rendering: the current state's pattern and a smooth fade when the state changes
#include "app.h"
#include <Adafruit_NeoPixel.h>

#define RGB_PIN 21

static Adafruit_NeoPixel pixel(1, RGB_PIN, NEO_GRB + NEO_KHZ800);
static float cur[3] = {0, 0, 0};  // shown color at full brightness
static float from[3] = {0, 0, 0}; // color at the start of the fade
static int shownState = -1;
static bool shownUpdating = false;
static unsigned long changeAt = 0;
static int previewState = -1;
static unsigned long previewUntil = 0;

static void show(const float c[3]) {
  uint8_t b = config.brightness;
  pixel.setPixelColor(0, pixel.Color(lroundf(c[0] * b / 255), lroundf(c[1] * b / 255), lroundf(c[2] * b / 255)));
  pixel.show();
}

// Pattern level 0..1 at phase t (0..1). The web page preview draws the same.
static float patternLevel(Pattern p, float t) {
  switch (p) {
    case PAT_BREATHE: {
      float x = 0.5f - 0.5f * cosf(2 * PI * t);
      return 0.12f + 0.88f * x * x;
    }
    case PAT_BLINK: return t < 0.5f ? 1 : 0;
    case PAT_DOUBLE: return (t < 0.1f || (t >= 0.2f && t < 0.3f)) ? 1 : 0;
    case PAT_FLASH: return t < 0.15f ? sinf(PI * t / 0.15f) : 0;
    default: return 1;
  }
}

static void hue(float h, float out[3]) {
  out[0] = 255 * constrain(fabsf(h * 6 - 3) - 1, 0.0f, 1.0f);
  out[1] = 255 * constrain(2 - fabsf(h * 6 - 2), 0.0f, 1.0f);
  out[2] = 255 * constrain(2 - fabsf(h * 6 - 4), 0.0f, 1.0f);
}

// State to show: a preview from the settings page wins over the current mode until it expires
static int visibleState() {
  if (previewState >= 0 && (long)(millis() - previewUntil) < 0) return previewState;
  previewState = -1;
  return stateIndex(currentMode);
}

static void target(int state, float out[3]) {
  if (updating) { // purple during a firmware upload
    out[0] = 255; out[1] = 0; out[2] = 255;
    return;
  }
  const StateStyle &s = config.states[state];
  float t = (millis() % s.period) / (float)s.period;
  if (s.pattern == PAT_RAINBOW) {
    hue(t, out);
    return;
  }
  float l = patternLevel(s.pattern, t);
  out[0] = s.r * l; out[1] = s.g * l; out[2] = s.b * l;
}

void ledBegin() {
  pixel.begin();
  pixel.clear();
  pixel.show();
}

void ledPreview(int state) {
  previewState = state;
  previewUntil = millis() + PREVIEW_MS;
}

void ledFrame() {
  int state = visibleState();
  if (state != shownState || updating != shownUpdating) {
    memcpy(from, cur, sizeof(cur));
    changeAt = millis();
    shownState = state;
    shownUpdating = updating;
  }
  float t[3];
  target(state, t);
  float k = config.fade ? (millis() - changeAt) / (float)config.fade : 1;
  if (k < 1) {
    k = k * k * (3 - 2 * k); // smoothstep
    for (int i = 0; i < 3; i++) cur[i] = from[i] + (t[i] - from[i]) * k;
  } else {
    memcpy(cur, t, sizeof(cur));
  }
  show(cur);
}

// For when loop() is not running (ArduinoOTA blocks)
void ledShowNow() {
  target(visibleState(), cur);
  show(cur);
}
