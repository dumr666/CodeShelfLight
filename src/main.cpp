#include "app.h"
#include <WiFi.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <ArduinoJson.h>
#include "secrets.h"

#define FRAME_MS 10

char currentMode = 'G';
bool updating = false; // OTA in progress -> purple
const char *lastSource = "-";
static unsigned long lastCommand = 0;
static bool gotCommand = false;
static unsigned long lastFrame = 0;
static unsigned long restartAt = 0;
static bool netStarted = false;

// Shared by USB, WiFi and BLE. Returns false for an unknown command.
bool applyCommand(char cmd, const char *source) {
  bool known = false;
  for (int i = 0; i < NUM_STATES; i++) known = known || STATE_CODES[i] == cmd;
  if (!known) return false;
  lastCommand = millis();
  gotCommand = true;
  lastSource = source;
  if (cmd == currentMode) return true;
  currentMode = cmd; // ledFrame() draws the color
  bleNotifyMode();
  return true;
}

void setBrightness(int v) {
  config.brightness = constrain(v, 0, 255);
  configSave();
  bleNotifyBrightness();
}

String statusJson() {
  JsonDocument d;
  d["mode"] = String(currentMode);
  d["state"] = STATE_KEYS[stateIndex(currentMode)];
  d["name"] = config.name;
  d["host"] = hostName();
  d["wifi"] = config.wifi;
  d["ble"] = config.ble;
  d["ip"] = WiFi.localIP().toString();
  d["ssid"] = WiFi.SSID();
  d["rssi"] = WiFi.RSSI();
  d["bleClients"] = bleClients();
  d["brightness"] = config.brightness;
  d["lastCommandAgo"] = gotCommand ? (long)((millis() - lastCommand) / 1000) : -1;
  d["source"] = lastSource;
  d["uptime"] = millis() / 1000;
  d["heap"] = ESP.getFreeHeap();
  d["version"] = FW_VERSION;
  d["build"] = __DATE__ " " __TIME__;
  String out;
  serializeJson(d, out);
  return out;
}

// Restart a bit later so the HTTP / BLE response still goes out
void scheduleRestart() {
  restartAt = millis() + 500;
}

// mDNS (<hostname>.local) and ArduinoOTA (pio run -e ota -t upload); ArduinoOTA starts mDNS itself
static void startNetwork() {
  ArduinoOTA.setHostname(hostName().c_str());
#ifdef OTA_PASSWORD
  ArduinoOTA.setPassword(OTA_PASSWORD);
#endif
  ArduinoOTA.onStart([]() { updating = true; configFlush(); ledShowNow(); });
  ArduinoOTA.onError([](ota_error_t e) { updating = false; });
  ArduinoOTA.begin();
  MDNS.addService("http", "tcp", 80);
  Serial.printf("WiFi OK: http://%s.local (%s)\n", hostName().c_str(), WiFi.localIP().toString().c_str());
}

void setup() {
  Serial.begin(115200);
  configLoad();
  ledBegin(); // green fades in from loop()

  if (config.wifi) {
    WiFi.mode(WIFI_STA);
    WiFi.setHostname(hostName().c_str());
    WiFi.setAutoReconnect(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    webBegin();
  } else {
    WiFi.mode(WIFI_OFF);
  }
  if (config.ble) bleBegin();
}

void loop() {
  // Commands over USB serial
  while (Serial.available() > 0) {
    applyCommand(Serial.read(), "usb");
  }

  // Commands over WiFi; mDNS and OTA start once we have an IP
  if (config.wifi) {
    if (WiFi.status() == WL_CONNECTED) {
      if (!netStarted) {
        startNetwork();
        netStarted = true;
      }
      webLoop();
      ArduinoOTA.handle();
    } else if (netStarted) {
      ArduinoOTA.end();
      netStarted = false;
    }
  }

  // States set by hand (BLE, web page) stay; the timeout is for when the PC (extension) goes away
  bool manual = !strcmp(lastSource, "ble") || !strcmp(lastSource, "web");
  if (config.timeout && gotCommand && currentMode != 'O' && !manual &&
      millis() - lastCommand > config.timeout * 1000UL) {
    currentMode = 'O';
    bleNotifyMode();
  }

  if (millis() - lastFrame >= FRAME_MS) {
    lastFrame = millis();
    ledFrame();
  }

  configLoop();
  if (restartAt && (long)(millis() - restartAt) >= 0) {
    configFlush();
    ESP.restart();
  }
}
