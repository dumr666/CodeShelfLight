// HTTP: web page, API for the extension and settings, firmware upload. See docs/protocol.md.
#include "app.h"
#include <WebServer.h>
#include <Update.h>
#include <ArduinoJson.h>
#include "webpage.h"

static WebServer server(80);
static bool uploadDenied = false;

// With an admin password set, the page, settings, scan, update and reboot need user "admin".
// /set, /status and /brightness stay open for the extension.
static bool authorized() {
  if (!config.adminPassword.length()) return true;
  if (server.authenticate("admin", config.adminPassword.c_str())) return true;
  server.requestAuthentication();
  return false;
}

static void sendJsonError(int code, const String &err) {
  JsonDocument d;
  d["error"] = err;
  String out;
  serializeJson(d, out);
  server.send(code, "application/json", out);
}

static void handleIndex() {
  if (!authorized()) return;
  server.sendHeader("Content-Encoding", "gzip");
  server.send_P(200, "text/html", (const char *)INDEX_HTML_GZ, INDEX_HTML_GZ_LEN);
}

// /set?c=T (code) or /set?s=working (state name); manual=1 = set by hand from the page, no timeout
static void handleSet() {
  char code = 0;
  String c = server.arg("c"), s = server.arg("s");
  if (c.length() == 1) code = toupper(c[0]);
  for (int i = 0; i < NUM_STATES; i++)
    if (s == STATE_KEYS[i]) code = STATE_CODES[i];
  if (code && applyCommand(code, server.arg("manual") == "1" ? "web" : "wifi")) {
    server.send(200, "text/plain", String(currentMode));
  } else {
    server.send(400, "text/plain", "use /set?c=T|G|Y|R|O or /set?s=working|waiting|attention|error|off");
  }
}

static void handleStatus() {
  server.send(200, "application/json", statusJson());
}

static void handleBrightness() {
  if (server.hasArg("v")) setBrightness(server.arg("v").toInt());
  server.send(200, "text/plain", String(config.brightness));
}

static void handleGetConfig() {
  if (!authorized()) return;
  server.send(200, "application/json", configToJson());
}

static void handlePostConfig() {
  if (!authorized()) return;
  bool reboot = false;
  String err;
  if (!configApplyJson(server.arg("plain"), reboot, err)) {
    sendJsonError(400, err);
    return;
  }
  server.send(200, "application/json", String("{\"reboot\":") + (reboot ? "true" : "false") + ",\"config\":" + configToJson() + "}");
  if (reboot) scheduleRestart();
}

// 202 while the scan runs; the page polls until it gets the list
static void handleScan() {
  if (!authorized()) return;
  String json;
  if (netScan(json)) server.send(200, "application/json", json);
  else server.send(202, "application/json", "{\"scanning\":true}");
}

static void handleReboot() {
  if (!authorized()) return;
  server.send(200, "text/plain", "OK");
  scheduleRestart();
}

// Called when the upload finishes
static void handleUpdateDone() {
  if (uploadDenied) {
    server.requestAuthentication();
    return;
  }
  bool ok = !Update.hasError();
  updating = false;
  server.sendHeader("Connection", "close");
  server.send(ok ? 200 : 500, "text/plain", ok ? "OK" : Update.errorString());
  if (ok) scheduleRestart();
}

// Called for every chunk of the uploaded file
static void handleUpdateUpload() {
  HTTPUpload &up = server.upload();
  if (up.status == UPLOAD_FILE_START) {
    uploadDenied = config.adminPassword.length() && !server.authenticate("admin", config.adminPassword.c_str());
    if (uploadDenied) return;
    updating = true;
    configFlush();
    Update.begin(UPDATE_SIZE_UNKNOWN);
  } else if (uploadDenied) {
    return;
  } else if (up.status == UPLOAD_FILE_WRITE) {
    Update.write(up.buf, up.currentSize);
  } else if (up.status == UPLOAD_FILE_END) {
    Update.end(true);
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    updating = false;
  }
}

void webBegin() {
  server.on("/", handleIndex);
  server.on("/set", handleSet);
  server.on("/status", handleStatus);
  server.on("/brightness", handleBrightness);
  server.on("/config", HTTP_GET, handleGetConfig);
  server.on("/config", HTTP_POST, handlePostConfig);
  server.on("/scan", HTTP_GET, handleScan);
  server.on("/reboot", HTTP_POST, handleReboot);
  server.on("/update", HTTP_POST, handleUpdateDone, handleUpdateUpload);
  server.begin();
}

void webLoop() {
  server.handleClient();
}
