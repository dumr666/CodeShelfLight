// Device settings: defaults, JSON (for web, BLE and USB) and NVS storage
#include "app.h"
#include <ArduinoJson.h>
#include <Preferences.h>

// Optional build-time defaults for developers (see include/secrets.h.example). Used only until the
// WiFi is set through the setup app, Bluetooth or the web page.
#if __has_include("secrets.h")
#include "secrets.h"
#endif

#define SAVE_DELAY_MS 2000

const char STATE_CODES[NUM_STATES] = {'T', 'G', 'Y', 'R', 'O'};
const char *const STATE_KEYS[NUM_STATES] = {"working", "waiting", "attention", "error", "off"};
const char *const PATTERN_KEYS[PAT_COUNT] = {"solid", "breathe", "blink", "double", "flash", "rainbow"};

Config config;
static Preferences prefs;
static unsigned long saveAt = 0;
static bool saveDirty = false;

static void setDefaults() {
  // Unique per device, so several lights do not share a name or a .local address
  uint64_t mac = ESP.getEfuseMac(); // byte 0 of the MAC is the lowest byte
  char name[24];
  snprintf(name, sizeof(name), "CodeShelf Light %02X%02X", (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));
  config.name = name;
  config.wifi = true;
  config.ble = true;
  config.wifiSsid = "";
  config.wifiPassword = "";
  config.adminPassword = "";
#ifdef WIFI_SSID
  config.wifiSsid = WIFI_SSID;
  config.wifiPassword = WIFI_PASSWORD;
#endif
#ifdef OTA_PASSWORD
  config.adminPassword = OTA_PASSWORD;
#endif
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

// States are [color, pattern, period] tuples to keep the JSON under 512 B (BLE characteristic limit).
// Passwords are never included; "auth" tells whether the admin password is set.
String configToJson() {
  JsonDocument d;
  d["name"] = config.name;
  d["host"] = hostName();
  d["wifi"] = config.wifi;
  d["ble"] = config.ble;
  d["ssid"] = config.wifiSsid;
  d["auth"] = config.adminPassword.length() > 0;
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

static bool applyJson(const String &json, bool &rebootNeeded, bool &wifiChanged, String &err) {
  JsonDocument d;
  if (deserializeJson(d, json) || !d.is<JsonObject>()) {
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
  if (d["ssid"].is<const char *>()) {
    next.wifiSsid = d["ssid"].as<String>();
    if (next.wifiSsid.length() > 32) {
      err = "WiFi network name must be at most 32 characters";
      return false;
    }
    // A network without a password is an open network
    if (!d["wifiPassword"].is<const char *>()) next.wifiPassword = "";
  }
  if (d["wifiPassword"].is<const char *>()) {
    next.wifiPassword = d["wifiPassword"].as<String>();
    if (next.wifiPassword.length() > 63 || (next.wifiPassword.length() > 0 && next.wifiPassword.length() < 8)) {
      err = "WiFi password must be 8-63 characters";
      return false;
    }
  }
  if (d["adminPassword"].is<const char *>()) {
    next.adminPassword = d["adminPassword"].as<String>();
    if (next.adminPassword.length() > 63) {
      err = "password must be at most 63 characters";
      return false;
    }
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
  wifiChanged = next.wifiSsid != config.wifiSsid || next.wifiPassword != config.wifiPassword;
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
  String before = configToJson() + '\n' + config.wifiPassword + '\n' + config.adminPassword;
  bool wifiChanged = false;
  if (!applyJson(json, rebootNeeded, wifiChanged, err)) return false;
  if (configToJson() + '\n' + config.wifiPassword + '\n' + config.adminPassword != before) configSave();
  if (wifiChanged && !rebootNeeded) netReconnect();
  return true;
}

void configSave() {
  saveDirty = true;
  saveAt = millis() + SAVE_DELAY_MS;
}

// The settings JSON has no passwords, so they go into their own keys
void configFlush() {
  if (!saveDirty) return;
  saveDirty = false;
  prefs.putString("config", configToJson());
  prefs.putString("wifiPass", config.wifiPassword);
  prefs.putString("adminPass", config.adminPassword);
}

void configLoop() {
  if (saveDirty && (long)(millis() - saveAt) >= 0) configFlush();
}

void configFactoryReset() {
  prefs.clear();
  saveDirty = false;
}

void configLoad() {
  setDefaults();
  prefs.begin("busylight"); // NVS namespace from the prototype, kept so existing lights keep their settings
  if (prefs.isKey("bright")) config.brightness = prefs.getUChar("bright"); // from the prototype
  if (prefs.isKey("config")) {
    bool reboot, wifiChanged;
    String err;
    String saved = prefs.getString("config");
    applyJson(saved, reboot, wifiChanged, err);
    if (prefs.isKey("wifiPass")) config.wifiPassword = prefs.getString("wifiPass");
    if (prefs.isKey("adminPass")) config.adminPassword = prefs.getString("adminPass");
  }
}
