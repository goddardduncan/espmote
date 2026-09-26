#include "USB.h"
#include "USBHIDMouse.h"
#include "USBHIDKeyboard.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Update.h>
#include "mbedtls/aes.h"

USBHIDMouse Mouse;
USBHIDKeyboard Keyboard;

// UUIDs
#define SERVICE_UUID           "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define MOUSE_CHARACTERISTIC   "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define KEYBOARD_CHARACTERISTIC "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
#define OTA_CHARACTERISTIC     "6e400004-b5a3-f393-e0a9-e50e24dcca9e"

// AES Configuration - MUST match the 16 chars in your Browser
unsigned char aes_key[] = "1234567890123456"; 

BLEServer* pServer = NULL;
bool deviceConnected = false;

// HID packets are queued by the BLE callbacks and handled in loop(),
// so key-press delays never stall the BLE stack
enum PacketSource : uint8_t { SRC_MOUSE, SRC_KEYBOARD, SRC_RELEASE };
struct HidPacket {
    PacketSource source;
    uint8_t len;
    uint8_t data[64];
};
QueueHandle_t hidQueue;

void releaseEverything() {
    Keyboard.releaseAll();
    Mouse.release(MOUSE_ALL);
}

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
        deviceConnected = true;
        Serial.println("Browser linked.");
    };

    void onDisconnect(BLEServer* pServer) {
        deviceConnected = false;
        Serial.println("Browser unlinked. Restarting Advertising...");
        // Nothing can arrive to release held keys/buttons now, so drop them
        HidPacket pkt = { SRC_RELEASE, 0 };
        xQueueSend(hidQueue, &pkt, 0);
        pServer->getAdvertising()->start();
    }
};

// Decrypts [IV(16)][ciphertext] into out (must hold len - 16 bytes) and strips PKCS7 padding.
// Returns the plaintext length, or -1 if the packet is malformed.
int decryptPacket(uint8_t* data, size_t len, uint8_t* out) {
    if (len < 32 || (len - 16) % 16 != 0) return -1;

    unsigned char dynamic_iv[16];
    memcpy(dynamic_iv, data, 16);

    uint8_t* ciphertext = data + 16;
    size_t cipherLen = len - 16;

    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);
    mbedtls_aes_setkey_dec(&aes, aes_key, 128);
    mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_DECRYPT, cipherLen, dynamic_iv, ciphertext, out);
    mbedtls_aes_free(&aes);

    uint8_t pad = out[cipherLen - 1];
    if (pad < 1 || pad > 16) return -1;
    return cipherLen - pad;
}

void decryptAndHandle(uint8_t* data, size_t len, bool isMouse) {
    if (len < 32) return;
    uint8_t decrypted[len - 16];
    if (decryptPacket(data, len, decrypted) < 1) return;

    char type = (char)decrypted[0];

    // --- MOUSE LOGIC ---
    if (isMouse) {
        if (type == 'm') Mouse.move((int8_t)decrypted[1], (int8_t)decrypted[2]);
        else if (type == 'c') {
            if (decrypted[2] == 1) Mouse.press(decrypted[1]); 
            else Mouse.release(decrypted[1]);
        }
        else if (type == 's') Mouse.move(0, 0, (int8_t)decrypted[1]);
    } 
    // --- KEYBOARD LOGIC ---
    else {
        // 'd'/'u': hold/release a key by USB HID usage ID (modifiers are 0xE0-0xE7)
        if (type == 'd') Keyboard.pressRaw(decrypted[1]);
        else if (type == 'u') Keyboard.releaseRaw(decrypted[1]);
        else if (type == 'r') releaseEverything();
        // 'k': press and release in one packet (burst paste, older web app)
        else if (type == 'k') {
            uint8_t val = decrypted[1];
            uint8_t mode = decrypted[2]; 
            uint8_t extra = decrypted[3]; 

            if (mode == 3 || mode == 4) { 
                uint8_t modifierKey = (mode == 3) ? KEY_LEFT_CTRL : KEY_LEFT_GUI;
                Keyboard.press(modifierKey);
                Keyboard.press(extra); 
                delay(15);
                Keyboard.releaseAll();
            }
            else {
                if (extra & 1) Keyboard.press(KEY_LEFT_SHIFT);
                if (extra & 2) Keyboard.press(KEY_LEFT_CTRL);
                if (extra & 4) Keyboard.press(KEY_LEFT_ALT);
                if (extra & 8) Keyboard.press(KEY_LEFT_GUI);

                if (mode == 1) { 
                    switch (val) {
                        case 8:  Keyboard.press(KEY_BACKSPACE); break;
                        case 9:  Keyboard.press(KEY_TAB); break;
                        case 13: Keyboard.press(KEY_RETURN); break;
                        case 27: Keyboard.press(KEY_ESC); break;
                        case 37: Keyboard.press(KEY_LEFT_ARROW); break;
                        case 38: Keyboard.press(KEY_UP_ARROW); break;
                        case 39: Keyboard.press(KEY_RIGHT_ARROW); break;
                        case 40: Keyboard.press(KEY_DOWN_ARROW); break;
                        case 45: Keyboard.press(KEY_INSERT); break;
                        case 46: Keyboard.press(KEY_DELETE); break;
                        case 36: Keyboard.press(KEY_HOME); break;
                        case 35: Keyboard.press(KEY_END); break;
                        case 33: Keyboard.press(KEY_PAGE_UP); break;
                        case 34: Keyboard.press(KEY_PAGE_DOWN); break;
                        case 112: Keyboard.press(KEY_F1); break;
                        case 113: Keyboard.press(KEY_F2); break;
                        case 114: Keyboard.press(KEY_F3); break;
                        case 115: Keyboard.press(KEY_F4); break;
                        case 116: Keyboard.press(KEY_F5); break;
                        case 117: Keyboard.press(KEY_F6); break;
                        case 118: Keyboard.press(KEY_F7); break;
                        case 119: Keyboard.press(KEY_F8); break;
                        case 120: Keyboard.press(KEY_F9); break;
                        case 121: Keyboard.press(KEY_F10); break;
                        case 122: Keyboard.press(KEY_F11); break;
                        case 123: Keyboard.press(KEY_F12); break;
                    }
                } else { 
                    Keyboard.press((char)val);
                }
                delay(15);
                Keyboard.releaseAll();
            }
        }
    }
} // End decryptAndHandle

class MyHIDCallbacks: public BLECharacteristicCallbacks {
    PacketSource source;
public:
    MyHIDCallbacks(PacketSource s) : source(s) {}

    void onWrite(BLECharacteristic *pC) {
        HidPacket pkt;
        size_t len = pC->getLength();
        if (len > sizeof(pkt.data)) return;
        pkt.source = source;
        pkt.len = len;
        memcpy(pkt.data, pC->getData(), len);
        xQueueSend(hidQueue, &pkt, 0);
    }
};

class MyOTACallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pC) {
        // OTA packets use the same encrypted envelope as HID, so only a holder of the key can flash
        size_t len = pC->getLength();
        if (len < 32) return;
        uint8_t d[len - 16];
        int l = decryptPacket(pC->getData(), len, d);
        if (l < 1) return;
        char cmd = (char)d[0];

        if (cmd == 'B') {
            if (l < 5) return;
            uint32_t fileSize;
            memcpy(&fileSize, d + 1, 4);
            Update.begin(fileSize);
        } else if (cmd == 'D') {
            Update.write(d + 1, l - 1);
        } else if (cmd == 'E') {
          if (Update.end(true)) {
              delay(500);
              ESP.restart();
          }
        }
    }
};

void setup() {
    Serial.begin(115200);
    Mouse.begin(); 
    Keyboard.begin(); 
    USB.begin();

    hidQueue = xQueueCreate(64, sizeof(HidPacket));

    BLEDevice::init("XIAO-moteMote");
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());

    BLEService *pService = pServer->createService(SERVICE_UUID);

    BLECharacteristic *mChar = pService->createCharacteristic(MOUSE_CHARACTERISTIC, BLECharacteristic::PROPERTY_WRITE_NR);
    BLECharacteristic *kChar = pService->createCharacteristic(KEYBOARD_CHARACTERISTIC, BLECharacteristic::PROPERTY_WRITE_NR);
    BLECharacteristic *otaChar = pService->createCharacteristic(OTA_CHARACTERISTIC, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_NOTIFY);

    mChar->setCallbacks(new MyHIDCallbacks(SRC_MOUSE));
    kChar->setCallbacks(new MyHIDCallbacks(SRC_KEYBOARD));
    otaChar->setCallbacks(new MyOTACallbacks());

    pService->start();

    BLEAdvertising *pAdvertising = pServer->getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    pAdvertising->start();
    Serial.println("XIAO-moteMote Ready...");
}

void loop() {
    HidPacket pkt;
    if (xQueueReceive(hidQueue, &pkt, pdMS_TO_TICKS(100)) != pdTRUE) return;

    if (pkt.source == SRC_RELEASE) releaseEverything();
    else decryptAndHandle(pkt.data, pkt.len, pkt.source == SRC_MOUSE);
}
