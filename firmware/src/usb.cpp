// USB serial: single-character states from the extension, and JSON-line requests from the setup app.
// A line that starts with "{" is a request; every other byte is a state code (T G Y R O) or ignored.
// See docs/protocol.md.
#include "app.h"
#include <ArduinoJson.h>

#define MAX_LINE 1024

static String line;
static bool inLine = false;
static JsonDocument pendingScan; // id of a scan request waiting for its result
static bool scanPending = false;

static void reply(JsonDocument &r) {
  serializeJson(r, Serial);
  Serial.println();
}

static void replyError(JsonVariantConst id, const String &err) {
  JsonDocument r;
  r["id"] = id;
  r["ok"] = false;
  r["error"] = err;
  reply(r);
}

static void handleRequest(const String &text) {
  JsonDocument req;
  if (deserializeJson(req, text)) {
    replyError(JsonVariantConst(), "invalid JSON");
    return;
  }
  JsonVariantConst id = req["id"];
  String cmd = req["cmd"] | "";
  JsonDocument r;
  r["id"] = id;
  r["ok"] = true;

  if (cmd == "info") {
    r["status"] = serialized(statusJson());
    r["config"] = serialized(configToJson());
  } else if (cmd == "set") {
    String body;
    serializeJson(req["config"], body);
    bool reboot = false;
    String err;
    if (!configApplyJson(body, reboot, err)) {
      replyError(id, err);
      return;
    }
    r["reboot"] = reboot;
    r["config"] = serialized(configToJson());
    if (reboot) scheduleRestart();
  } else if (cmd == "scan") {
    String json;
    netScan(json); // starts the scan; usbLoop() replies when it is done
    pendingScan.clear();
    pendingScan["id"] = id;
    scanPending = true;
    return;
  } else if (cmd == "reboot") {
    scheduleRestart();
  } else if (cmd == "factory-reset") {
    configFactoryReset();
    scheduleRestart();
  } else {
    replyError(id, "unknown command: " + cmd);
    return;
  }
  reply(r);
}

void usbLoop() {
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (inLine) {
      if (c == '\n') {
        inLine = false;
        handleRequest(line);
        line = "";
      } else if (line.length() < MAX_LINE) {
        line += c;
      }
    } else if (c == '{') {
      inLine = true;
      line = "{";
    } else {
      applyCommand(c, "usb"); // ignores \r, \n and unknown bytes
    }
  }

  String json;
  if (scanPending && netScan(json)) {
    scanPending = false;
    JsonDocument r;
    r["id"] = pendingScan["id"];
    r["ok"] = true;
    r["networks"] = serialized(json);
    reply(r);
  }
}
