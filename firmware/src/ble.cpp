// BLE: device name = config.name, values are UTF-8 text (readable in LightBlue / nRF Connect).
// UUIDs start with "c1a0de" so you can spot them in an app.
#include "app.h"
#include <NimBLEDevice.h>

#define BLE_SERVICE_UUID "c1a0de00-0000-4000-8000-000000000000"
#define BLE_MODE_UUID "c1a0de01-0000-4000-8000-000000000000"    // "T" | "G" | "Y" | "R" | "O"
#define BLE_BRIGHT_UUID "c1a0de02-0000-4000-8000-000000000000"  // "0" .. "255"
#define BLE_CONFIG_UUID "c1a0de03-0000-4000-8000-000000000000"  // JSON like GET/POST /config
#define BLE_STATUS_UUID "c1a0de04-0000-4000-8000-000000000000"  // JSON like GET /status
#define BLE_COMMAND_UUID "c1a0de05-0000-4000-8000-000000000000" // "reboot"

static NimBLEServer *bleServer = nullptr;
static NimBLECharacteristic *bleMode = nullptr;
static NimBLECharacteristic *bleBright = nullptr;

class ModeCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    std::string v = c->getValue();
    if (v.empty() || !applyCommand(toupper(v[0]), "ble")) c->setValue(std::string(1, currentMode));
  }
};

// Accepts text ("0".."255") or a single raw byte (hex mode in LightBlue / nRF Connect).
// Rejects an invalid value so the light does not turn off by mistake.
class BrightCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    std::string v = c->getValue();
    bool isText = !v.empty() && v.size() <= 3;
    for (char ch : v) isText = isText && isdigit((unsigned char)ch);
    if (isText) setBrightness(atoi(v.c_str()));
    else if (v.size() == 1) setBrightness((uint8_t)v[0]);
    else c->setValue(std::string(String(config.brightness).c_str()));
  }
};

// On an error the value resets to the current config, so a client sees on read what applies
class ConfigCallbacks : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    c->setValue(configToJson().c_str());
  }
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    bool reboot = false;
    String err;
    configApplyJson(String(c->getValue().c_str()), reboot, err);
    c->setValue(configToJson().c_str());
    bleNotifyBrightness();
    if (reboot) scheduleRestart();
  }
};

class StatusCallbacks : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    c->setValue(statusJson().c_str());
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &info) override {
    if (c->getValue() == "reboot") scheduleRestart();
  }
};

// Characteristic name (0x2901) that apps show instead of the UUID, and a marker that the value is UTF-8 (0x2904)
static NimBLECharacteristic *addChar(NimBLEService *svc, const char *uuid, uint32_t props, const char *name,
                                     NimBLECharacteristicCallbacks *cb) {
  NimBLECharacteristic *c = svc->createCharacteristic(uuid, props);
  c->createDescriptor(NimBLEUUID((uint16_t)0x2901), NIMBLE_PROPERTY::READ, strlen(name))->setValue(name);
  c->create2904()->setFormat(NimBLE2904::FORMAT_UTF8);
  c->setCallbacks(cb);
  return c;
}

void bleBegin() {
  NimBLEDevice::init(config.name.c_str());
  NimBLEDevice::setMTU(517);
  bleServer = NimBLEDevice::createServer();
  bleServer->advertiseOnDisconnect(true);
  NimBLEService *svc = bleServer->createService(BLE_SERVICE_UUID);
  uint32_t rwn = NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::NOTIFY;
  bleMode = addChar(svc, BLE_MODE_UUID, rwn, "Mode (T/G/Y/R/O)", new ModeCallbacks());
  bleMode->setValue(std::string(1, currentMode));
  bleBright = addChar(svc, BLE_BRIGHT_UUID, rwn, "Brightness (0-255)", new BrightCallbacks());
  bleBright->setValue(std::string(String(config.brightness).c_str()));
  addChar(svc, BLE_CONFIG_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE, "Settings (JSON)", new ConfigCallbacks());
  addChar(svc, BLE_STATUS_UUID, NIMBLE_PROPERTY::READ, "Status (JSON)", new StatusCallbacks());
  addChar(svc, BLE_COMMAND_UUID, NIMBLE_PROPERTY::WRITE, "Command (reboot)", new CommandCallbacks());
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->setName(config.name.c_str());
  adv->addServiceUUID(BLE_SERVICE_UUID);
  adv->enableScanResponse(true);
  adv->setMinInterval(800); // 500-1000 ms instead of ~30 ms: far less radio time, the app still finds the light in a second or two
  adv->setMaxInterval(1600);
  adv->start();
}

void bleNotifyMode() {
  if (!bleMode) return;
  bleMode->setValue(std::string(1, currentMode));
  bleMode->notify();
}

void bleNotifyBrightness() {
  if (!bleBright) return;
  bleBright->setValue(std::string(String(config.brightness).c_str()));
  bleBright->notify();
}

int bleClients() {
  return bleServer ? bleServer->getConnectedCount() : 0;
}
