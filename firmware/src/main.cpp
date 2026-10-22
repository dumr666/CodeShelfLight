// CodeShelf Light firmware: setup, main loop, state commands and status
#include "app.h"
#include <WiFi.h>
#include <ArduinoJson.h>

#define FRAME_MS 10

char currentMode = 'G';
bool updating = false; // firmware upload in progress -> purple
const char *lastSource = "-";
static unsigned long lastCommand = 0;
static bool gotCommand = false;
static unsigned long lastFrame = 0;
static unsigned long restartAt = 0;

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
  int b = constrain(v, 0, 255);
  if (b == config.brightness) return;
  config.brightness = b;
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
  d["wifiState"] = netState();
  d["ssid"] = config.wifiSsid;
  bool connected = WiFi.status() == WL_CONNECTED;
  d["ip"] = connected ? WiFi.localIP().toString() : "";
  d["rssi"] = connected ? WiFi.RSSI() : 0;
  d["mac"] = WiFi.macAddress();
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

// Restart a bit later so the HTTP / BLE / USB response still goes out
void scheduleRestart() {
  restartAt = millis() + 500;
}

void setup() {
  Serial.begin(115200);
  configLoad();
  ledBegin(); // green fades in from loop()
  if (config.wifi) netBegin();
  else WiFi.mode(WIFI_OFF);
  if (config.ble) bleBegin();
  Serial.printf("CodeShelf Light %s \"%s\"\n", FW_VERSION, config.name.c_str());
}

void loop() {
  usbLoop();
  netLoop();

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
