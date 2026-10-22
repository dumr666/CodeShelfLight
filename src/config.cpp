// Device settings: defaults, JSON (for web and BLE) and NVS storage
#include "app.h"
#include <ArduinoJson.h>
#include <Preferences.h>

#define SAVE_DELAY_MS 2000

const char STATE_CODES[NUM_STATES] = {'T', 'G', 'Y', 'R', 'O'};
const char *const STATE_KEYS[NUM_STATES] = {"working", "waiting", "attention", "error", "off"};
const char *const PATTERN_KEYS[PAT_COUNT] = {"solid", "breathe", "blink", "double", "flash", "rainbow"};

Config config;
static Preferences prefs;
static unsigned long saveAt = 0;
static bool saveDirty = false;

static void setDefaults() {
  config.name = "CodeShelf Light";
  config.wifi = true;
  config.ble = true;
  config.brightness = 64;
  config.timeout = 30;
  config.fade = 600;
  config.states[0] = {0, 0, 255, PAT_BREATHE, 2600}; // working: blue, breathing
  config.states[1] = {0, 255, 0, PAT_SOLID, 2000};   // waiting: green
  config.states[2] = {255, 70, 0, PAT_SOLID, 1200};  // attention: amber
  config.states[3] = {255, 0, 0, PAT_SOLID, 1000};   // error: red
  config.states[4] = {0, 0, 0, PAT_SOLID, 1000};     // off
}

int stateIndex(char code) {
  for (int i = 0; i < NUM_STATES; i++)
    if (STATE_CODES[i] == code) return i;
  return NUM_STATES - 1;
}

String hostName() {
  String h;
  for (char c : config.name) {
    if (isalnum((unsigned char)c)) h += (char)tolower(c);
    else if (h.length() && !h.endsWith("-")) h += '-';
  }
  while (h.endsWith("-")) h.remove(h.length() - 1);
  return h.length() ? h : "codeshelf-light";
}

static String toHex(const StateStyle &s) {
  char buf[8];
  snprintf(buf, sizeof(buf), "#%02x%02x%02x", s.r, s.g, s.b);
  return buf;
}

static bool parseHex(const char *h, StateStyle &s) {
  if (!h || h[0] != '#' || strlen(h) != 7) return false;
  for (int i = 1; i < 7; i++)
    if (!isxdigit((unsigned char)h[i])) return false;
  uint32_t v = strtoul(h + 1, nullptr, 16);
  s.r = v >> 16;
  s.g = v >> 8;
  s.b = v;
  return true;
}

static int patternIndex(const char *k) {
  for (int i = 0; i < PAT_COUNT; i++)
    if (k && !strcmp(k, PATTERN_KEYS[i])) return i;
  return -1;
}

// States are [color, pattern, period] tuples to keep the JSON under 512 B (BLE characteristic limit)
String configToJson() {
  JsonDocument d;
  d["name"] = config.name;
  d["host"] = hostName();
  d["wifi"] = config.wifi;
  d["ble"] = config.ble;
  d["brightness"] = config.brightness;
  d["timeout"] = config.timeout;
  d["fade"] = config.fade;
  JsonObject states = d["states"].to<JsonObject>();
  for (int i = 0; i < NUM_STATES; i++) {
    const StateStyle &s = config.states[i];
    JsonArray a = states[STATE_KEYS[i]].to<JsonArray>();
    a.add(toHex(s));
    a.add(PATTERN_KEYS[s.pattern]);
    a.add(s.period);
  }
  String out;
  serializeJson(d, out);
  return out;
}

static bool applyJson(const String &json, bool &rebootNeeded, String &err) {
  JsonDocument d;
  if (deserializeJson(d, json)) {
    err = "invalid JSON";
    return false;
  }
  Config next = config;
  if (d["name"].is<const char *>()) {
    String n = d["name"].as<String>();
    n.trim();
    if (n.length() < 1 || n.length() > 29) {
      err = "name must be 1-29 characters";
      return false;
    }
    next.name = n;
  }
  if (d["wifi"].is<bool>()) next.wifi = d["wifi"];
  if (d["ble"].is<bool>()) next.ble = d["ble"];
  if (!next.wifi && !next.ble) {
    err = "WiFi and Bluetooth cannot both be off";
    return false;
  }
  if (d["brightness"].is<int>()) next.brightness = constrain(d["brightness"].as<int>(), 0, 255);
  if (d["timeout"].is<int>()) next.timeout = constrain(d["timeout"].as<int>(), 0, 3600);
  if (d["fade"].is<int>()) next.fade = constrain(d["fade"].as<int>(), 0, 5000);
  JsonObject states = d["states"];
  if (!states.isNull()) {
    for (int i = 0; i < NUM_STATES; i++) {
      JsonArray a = states[STATE_KEYS[i]];
      if (a.isNull()) continue;
      StateStyle s = next.states[i];
      int p = patternIndex(a[1] | "");
      if (!parseHex(a[0] | "", s) || p < 0) {
        err = String("invalid style for ") + STATE_KEYS[i];
        return false;
      }
      s.pattern = (Pattern)p;
      s.period = constrain(a[2] | 1000, 200, 10000);
      next.states[i] = s;
    }
  }
  rebootNeeded = next.name != config.name || next.wifi != config.wifi || next.ble != config.ble;
  config = next;
  if (d["preview"].is<const char *>()) {
    const char *p = d["preview"];
    int idx = -1;
    for (int i = 0; i < NUM_STATES; i++)
      if (!strcmp(p, STATE_KEYS[i])) idx = i;
    ledPreview(idx);
  }
  return true;
}

bool configApplyJson(const String &json, bool &rebootNeeded, String &err) {
  String before = configToJson();
  if (!applyJson(json, rebootNeeded, err)) return false;
  if (configToJson() != before) configSave();
  return true;
}

void configSave() {
  saveDirty = true;
  saveAt = millis() + SAVE_DELAY_MS;
}

void configFlush() {
  if (!saveDirty) return;
  saveDirty = false;
  prefs.putString("config", configToJson());
}

void configLoop() {
  if (saveDirty && (long)(millis() - saveAt) >= 0) configFlush();
}

void configLoad() {
  setDefaults();
  prefs.begin("busylight");
  if (prefs.isKey("bright")) config.brightness = prefs.getUChar("bright"); // from FW 1.x
  if (prefs.isKey("config")) {
    bool reboot;
    String err;
    applyJson(prefs.getString("config"), reboot, err);
  }
}
