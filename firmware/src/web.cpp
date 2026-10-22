// HTTP: web page, API for the extension and settings, firmware upload. See docs/protocol.md.
#include "app.h"
#include <WebServer.h>
#include <Update.h>
#include <ArduinoJson.h>
#include "webpage.h"

static WebServer server(80);
static bool uploadDenied = false;

// With an admin password set, the page, settings, scan, update, reboot, questions and chat need user "admin".
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

// ---- Question from an agent (POST /ask), answered on the page (POST /answer). One at a time, kept in RAM.
#define ASK_MAX_OPTIONS 6
static struct {
  uint32_t id = 0;       // 0 = none
  uint32_t lastId = 0;
  uint32_t expires = 0;  // millis()
  String title, text, answer;
  String options[ASK_MAX_OPTIONS];
  int optionCount = 0;
  bool free = false;
  bool answered = false;
} ask;

static bool askActive() {
  if (ask.id && (int32_t)(millis() - ask.expires) >= 0) ask.id = 0;
  return ask.id != 0;
}

static String askJson() {
  JsonDocument d;
  d["id"] = askActive() ? ask.id : 0;
  if (ask.id) {
    d["title"] = ask.title;
    d["text"] = ask.text;
    d["free"] = ask.free;
    JsonArray o = d["options"].to<JsonArray>();
    for (int i = 0; i < ask.optionCount; i++) o.add(ask.options[i]);
    if (ask.answered) d["answer"] = ask.answer;
    d["ttl"] = (int)((ask.expires - millis()) / 1000);
  }
  String out;
  serializeJson(d, out);
  return out;
}

static void handleAskGet() {
  if (!authorized()) return;
  server.send(200, "application/json", askJson());
}

static void handleAskPost() {
  if (!authorized()) return;
  JsonDocument d;
  if (deserializeJson(d, server.arg("plain")) || !d.is<JsonObject>()) {
    sendJsonError(400, "invalid JSON");
    return;
  }
  JsonArray opts = d["options"].as<JsonArray>();
  bool free = d["free"] | false;
  if (opts.size() > ASK_MAX_OPTIONS || (opts.size() == 0 && !free)) {
    sendJsonError(400, "give 1-6 options or free text");
    return;
  }
  ask.title = String(d["title"] | "").substring(0, 80);
  ask.text = String(d["text"] | "").substring(0, 400);
  ask.optionCount = 0;
  for (JsonVariant v : opts) ask.options[ask.optionCount++] = String(v.as<const char *>() ? v.as<const char *>() : "").substring(0, 60);
  ask.free = free;
  ask.answer = "";
  ask.answered = false;
  ask.id = ++ask.lastId;
  uint32_t ttl = constrain((int)(d["ttl"] | 90), 5, 600);
  ask.expires = millis() + ttl * 1000UL;
  server.send(200, "application/json", String("{\"id\":") + ask.id + "}");
}

static void handleAnswer() {
  if (!authorized()) return;
  JsonDocument d;
  if (deserializeJson(d, server.arg("plain")) || !d.is<JsonObject>()) {
    sendJsonError(400, "invalid JSON");
    return;
  }
  String answer = String(d["answer"] | "").substring(0, 300);
  if (!askActive() || (uint32_t)(d["id"] | 0) != ask.id) {
    sendJsonError(409, "the question is gone");
    return;
  }
  if (ask.answered) {
    sendJsonError(409, "already answered");
    return;
  }
  bool known = false;
  for (int i = 0; i < ask.optionCount; i++) known |= ask.options[i] == answer;
  if (!answer.length() || (!known && !ask.free)) {
    sendJsonError(400, "not one of the options");
    return;
  }
  ask.answer = answer;
  ask.answered = true;
  server.send(200, "application/json", "{}");
}

static void handleAskClear() {
  if (!authorized()) return;
  ask.id = 0;
  server.send(200, "application/json", "{}");
}

// ---- Chat: a prompt typed on the page waits here until the extension picks it up and runs it on the computer.
// The answers (and what the agents say at their desks) come back as messages. History is kept in RAM only.
#define CHAT_MAX 8
#define CHAT_TEXT 2500
#define CHAT_PROJECTS 8
#define PROMPT_TTL_MS (20UL * 60 * 1000)  // a prompt nobody finishes frees the slot after this
struct ChatMsg {
  uint32_t id = 0;
  char role = 'n';  // u = you, a = agent, n = note
  String project, text;
};
static ChatMsg chatMsgs[CHAT_MAX];
static int chatCount = 0;
static uint32_t chatLastId = 0;
static String chatProjects[CHAT_PROJECTS];  // folders the extension offers
static int chatProjectCount = 0;
static struct {
  uint32_t id = 0;  // 0 = none
  uint32_t lastId = 0;
  uint32_t started = 0;
  bool taken = false;  // the extension is running it
  bool newChat = false;
  String project, text;
} prompt;

// Cut to n bytes without splitting a UTF-8 character
static String clip(const String &s, unsigned n) {
  if (s.length() <= n) return s;
  unsigned cut = n;
  while (cut > 0 && (s[cut] & 0xC0) == 0x80) cut--;
  return s.substring(0, cut);
}

static bool promptActive() {
  if (prompt.id && millis() - prompt.started >= PROMPT_TTL_MS) prompt.id = 0;
  return prompt.id != 0;
}

static void chatAdd(char role, const String &project, const String &text) {
  if (chatCount == CHAT_MAX) {
    for (int i = 1; i < CHAT_MAX; i++) chatMsgs[i - 1] = chatMsgs[i];
    chatCount--;
  }
  ChatMsg &m = chatMsgs[chatCount++];
  m.id = ++chatLastId;
  m.role = role;
  m.project = clip(project, 40);
  m.text = clip(text, CHAT_TEXT);
}

static bool readBody(JsonDocument &d) {
  if (deserializeJson(d, server.arg("plain")) || !d.is<JsonObject>()) {
    sendJsonError(400, "invalid JSON");
    return false;
  }
  return true;
}

// GET /chat?after=ID: the projects and the messages newer than ID. Streamed so the history never sits in RAM twice.
static void handleChatGet() {
  if (!authorized()) return;
  uint32_t after = server.arg("after").toInt();
  JsonDocument d;
  d["seq"] = chatLastId;
  d["running"] = promptActive();
  JsonArray p = d["projects"].to<JsonArray>();
  for (int i = 0; i < chatProjectCount; i++) p.add(chatProjects[i]);
  String head;
  serializeJson(d, head);
  head.remove(head.length() - 1);
  head += ",\"msgs\":[";
  server.setContentLength(CONTENT_LENGTH_UNKNOWN);
  server.send(200, "application/json", "");
  server.sendContent(head);
  bool first = true;
  for (int i = 0; i < chatCount; i++) {
    const ChatMsg &c = chatMsgs[i];
    if (c.id <= after) continue;
    JsonDocument m;
    m["id"] = c.id;
    m["role"] = c.role == 'u' ? "user" : c.role == 'a' ? "assistant" : "note";
    m["project"] = c.project;
    m["text"] = c.text;
    String s;
    serializeJson(m, s);
    server.sendContent(first ? s : "," + s);
    first = false;
  }
  server.sendContent("]}");
  server.sendContent("");
}

// POST /chat {"text","project","newChat"}: from the page
static void handleChatPost() {
  if (!authorized()) return;
  JsonDocument d;
  if (!readBody(d)) return;
  String text = clip(String(d["text"] | ""), CHAT_TEXT);
  String project = clip(String(d["project"] | ""), 40);
  text.trim();
  bool known = false;
  for (int i = 0; i < chatProjectCount; i++) known |= chatProjects[i] == project;
  if (!text.length()) return sendJsonError(400, "empty prompt");
  if (!known) return sendJsonError(400, "unknown project");
  if (promptActive()) return sendJsonError(409, "the agent is still working on the previous prompt");
  prompt.id = ++prompt.lastId;
  prompt.started = millis();
  prompt.taken = false;
  prompt.newChat = d["newChat"] | false;
  prompt.project = project;
  prompt.text = text;
  chatAdd('u', project, text);
  server.send(200, "application/json", String("{\"id\":") + prompt.id + "}");
}

// POST /chat/next: the extension takes the waiting prompt (once)
static void handleChatNext() {
  if (!authorized()) return;
  if (!promptActive() || prompt.taken) return server.send(200, "application/json", "{\"id\":0}");
  prompt.taken = true;
  JsonDocument d;
  d["id"] = prompt.id;
  d["project"] = prompt.project;
  d["text"] = prompt.text;
  d["newChat"] = prompt.newChat;
  String out;
  serializeJson(d, out);
  server.send(200, "application/json", out);
}

// POST /chat/done: the prompt is finished, the page may send the next
static void handleChatDone() {
  if (!authorized()) return;
  prompt.id = 0;
  server.send(200, "application/json", "{}");
}

// POST /chat/msg {"role":"user|assistant|note","project","text"}: from the extension and the hooks
static void handleChatMsg() {
  if (!authorized()) return;
  JsonDocument d;
  if (!readBody(d)) return;
  String role = String(d["role"] | "");
  String text = String(d["text"] | "");
  if (!text.length() || (role != "user" && role != "assistant" && role != "note")) return sendJsonError(400, "give a role and text");
  // The page already shows what you typed; the hook reports the same prompt once the agent got it
  if (role == "user" && chatCount && chatMsgs[chatCount - 1].role == 'u' && chatMsgs[chatCount - 1].text == clip(text, CHAT_TEXT))
    return server.send(200, "application/json", String("{\"id\":") + chatLastId + "}");
  chatAdd(role[0] == 'u' ? 'u' : role[0] == 'a' ? 'a' : 'n', String(d["project"] | ""), text);
  server.send(200, "application/json", String("{\"id\":") + chatLastId + "}");
}

// POST /chat/projects {"projects":["name",…]}: the folders the page may pick from
static void handleChatProjects() {
  if (!authorized()) return;
  JsonDocument d;
  if (!readBody(d)) return;
  chatProjectCount = 0;
  for (JsonVariant v : d["projects"].as<JsonArray>()) {
    const char *name = v.as<const char *>();
    if (name && *name && chatProjectCount < CHAT_PROJECTS) chatProjects[chatProjectCount++] = clip(String(name), 40);
  }
  server.send(200, "application/json", "{}");
}

static void handleChatClear() {
  if (!authorized()) return;
  chatCount = 0;
  server.send(200, "application/json", "{}");
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
  server.on("/ask", HTTP_GET, handleAskGet);
  server.on("/ask", HTTP_POST, handleAskPost);
  server.on("/ask/clear", HTTP_POST, handleAskClear);
  server.on("/answer", HTTP_POST, handleAnswer);
  server.on("/chat", HTTP_GET, handleChatGet);
  server.on("/chat", HTTP_POST, handleChatPost);
  server.on("/chat/next", HTTP_POST, handleChatNext);
  server.on("/chat/done", HTTP_POST, handleChatDone);
  server.on("/chat/msg", HTTP_POST, handleChatMsg);
  server.on("/chat/projects", HTTP_POST, handleChatProjects);
  server.on("/chat/clear", HTTP_POST, handleChatClear);
  server.on("/reboot", HTTP_POST, handleReboot);
  server.on("/update", HTTP_POST, handleUpdateDone, handleUpdateUpload);
  server.begin();
}

void webLoop() {
  server.handleClient();
}
