// Shared declarations between modules: config.cpp, led.cpp, net.cpp, web.cpp, ble.cpp, usb.cpp, main.cpp
#pragma once
#include <Arduino.h>

#define FW_VERSION "1.0.0"

// Light states. The code is the character the extension sends (USB, HTTP /set?c=, BLE).
#define NUM_STATES 5
extern const char STATE_CODES[NUM_STATES];        // T G Y R O
extern const char *const STATE_KEYS[NUM_STATES];  // working waiting attention error off

enum Pattern : uint8_t { PAT_SOLID, PAT_BREATHE, PAT_BLINK, PAT_DOUBLE, PAT_FLASH, PAT_RAINBOW, PAT_COUNT };
extern const char *const PATTERN_KEYS[PAT_COUNT];

struct StateStyle {
  uint8_t r, g, b;
  Pattern pattern;
  uint16_t period; // ms, length of one pattern cycle
};

struct Config {
  String name;          // display name and BLE name; the hostname is a slug (CodeShelf Light -> codeshelf-light)
  bool wifi;
  bool ble;
  String wifiSsid;
  String wifiPassword;  // never sent back to clients
  String adminPassword; // protects the web page, settings and OTA when set; never sent back
  uint8_t brightness;   // 0-255
  uint16_t timeout;     // s without an extension command before turning off; 0 = never
  uint16_t fade;        // ms fade between states
  StateStyle states[NUM_STATES];
};

// How long a state preview from the settings page lasts after the last refresh
#define PREVIEW_MS 15000

extern Config config;
extern char currentMode;
extern bool updating;
extern const char *lastSource;

// config.cpp
void configLoad();
// Changes apply at once; the NVS write is delayed so live sliders do not wear out the flash
void configSave();
void configLoop();
void configFlush();
void configFactoryReset();
String configToJson();
// Apply partial JSON (see docs/protocol.md). Returns false and err on an invalid value.
// rebootNeeded is set if the name, WiFi on/off or Bluetooth on/off changed.
// New WiFi credentials reconnect without a reboot.
// A "preview" key ("working", ...; "" ends it) shows that state on the light for PREVIEW_MS without changing the mode.
bool configApplyJson(const String &json, bool &rebootNeeded, String &err);
String hostName();
int stateIndex(char code);

// led.cpp
void ledBegin();
void ledFrame();
void ledShowNow();
void ledPreview(int state); // -1 ends the preview

// net.cpp
void netBegin();
void netLoop();
void netReconnect();
const char *netState(); // off | unconfigured | connecting | connected | wrong-password | not-found
bool netScan(String &json); // starts or polls an async scan; true and the JSON array when done

// web.cpp
void webBegin();
void webLoop();

// ble.cpp
void bleBegin();
void bleNotifyMode();
void bleNotifyBrightness();
int bleClients();

// usb.cpp
void usbLoop();

// main.cpp
bool applyCommand(char cmd, const char *source);
void setBrightness(int v);
String statusJson();
void scheduleRestart();
