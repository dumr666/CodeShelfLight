// WiFi: connecting with the saved credentials, connection state, network scan, mDNS and ArduinoOTA
#include "app.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <ArduinoJson.h>

static bool started = false;   // WiFi was turned on at boot
static bool netUp = false;     // mDNS and OTA are running
static uint8_t lastReason = 0; // why the last connection attempt failed

static void onDisconnected(arduino_event_id_t event, arduino_event_info_t info) {
  lastReason = info.wifi_sta_disconnected.reason;
}

static void onConnected(arduino_event_id_t event, arduino_event_info_t info) {
  lastReason = 0;
}

static void connect() {
  lastReason = 0;
  WiFi.disconnect();
  if (config.wifiSsid.length()) WiFi.begin(config.wifiSsid.c_str(), config.wifiPassword.c_str());
}

void netBegin() {
  started = true;
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(hostName().c_str());
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(WIFI_PS_MIN_MODEM); // radio sleeps between beacons; requests still arrive (~100 ms extra)
  WiFi.onEvent(onDisconnected, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.onEvent(onConnected, ARDUINO_EVENT_WIFI_STA_GOT_IP);
  connect();
  webBegin();
}

void netReconnect() {
  if (started) connect();
}

const char *netState() {
  if (!started) return "off";
  if (!config.wifiSsid.length()) return "unconfigured";
  if (WiFi.status() == WL_CONNECTED) return "connected";
  switch (lastReason) {
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_AUTH_EXPIRE:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
      return "wrong-password";
    case WIFI_REASON_NO_AP_FOUND:
      return "not-found";
    default:
      return "connecting";
  }
}

// mDNS: <hostname>.local plus a _codeshelf._tcp service so the extension can find lights.
// ArduinoOTA starts mDNS itself.
static void startServices() {
  ArduinoOTA.setHostname(hostName().c_str());
  if (config.adminPassword.length()) ArduinoOTA.setPassword(config.adminPassword.c_str());
  ArduinoOTA.onStart([]() { updating = true; configFlush(); ledShowNow(); });
  ArduinoOTA.onError([](ota_error_t e) { updating = false; });
  ArduinoOTA.begin();
  MDNS.addService("http", "tcp", 80);
  MDNS.addService("codeshelf", "tcp", 80);
  MDNS.addServiceTxt("codeshelf", "tcp", "name", config.name.c_str());
  MDNS.addServiceTxt("codeshelf", "tcp", "version", FW_VERSION);
  Serial.printf("WiFi connected: http://%s.local (%s)\n", hostName().c_str(), WiFi.localIP().toString().c_str());
}

void netLoop() {
  if (!started) return;
  if (WiFi.status() == WL_CONNECTED) {
    if (!netUp) {
      startServices();
      netUp = true;
    }
    webLoop();
    ArduinoOTA.handle();
  } else if (netUp) {
    ArduinoOTA.end(); // also stops mDNS; both restart on the next connection
    netUp = false;
  }
}

// Async, so the LED and the web server keep running. The radio must be in station mode.
bool netScan(String &json) {
  if (!started && WiFi.getMode() == WIFI_OFF) WiFi.mode(WIFI_STA);
  int n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) return false;
  if (n == WIFI_SCAN_FAILED) {
    WiFi.scanNetworks(true);
    return false;
  }
  // Strongest entry per network name, strongest first (the scan is already sorted by signal)
  JsonDocument d;
  JsonArray list = d.to<JsonArray>();
  for (int i = 0; i < n && list.size() < 20; i++) {
    String ssid = WiFi.SSID(i);
    if (!ssid.length()) continue;
    bool seen = false;
    for (JsonObject o : list) seen = seen || o["ssid"] == ssid;
    if (seen) continue;
    JsonObject o = list.add<JsonObject>();
    o["ssid"] = ssid;
    o["rssi"] = WiFi.RSSI(i);
    o["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }
  WiFi.scanDelete();
  if (!started) WiFi.mode(WIFI_OFF);
  json = "";
  serializeJson(d, json);
  return true;
}
