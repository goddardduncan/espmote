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

// AES Configuration - Ensure these match your HTML exactly
unsigned char aes_key[] = "1234567890123456"; 
unsigned char aes_iv[]  = "abcdefghijklmnop"; 

BLEServer* pServer = NULL;
bool deviceConnected = false;

// 1. Server Callbacks: Enables Auto-Re-Advertising
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
        deviceConnected = true;
        Serial.println("Browser linked.");
    };

    void onDisconnect(BLEServer* pServer) {
        deviceConnected = false;
        Serial.println("Browser unlinked. Restarting Advertising...");
        // This is the "best of" fix: keeps the device visible for reconnecting
        pServer->getAdvertising()->start();
    }
};

// AES Decryption Helper
void decryptAndHandle(uint8_t* data, size_t len, String uuid) {
    // AES blocks must be 16-byte aligned
    if (len == 0 || len % 16 != 0) return;

    uint8_t decrypted[len];
    unsigned char iv_copy[16];
    memcpy(iv_copy, aes_iv, 16); // IV is modified by the process, so we use a copy

    mbedtls_aes_context aes;
    mbedtls_aes_init(&aes);
    mbedtls_aes_setkey_dec(&aes, aes_key, 128);
    mbedtls_aes_crypt_cbc(&aes, MBEDTLS_AES_DECRYPT, len, iv_copy, data, decrypted);
    mbedtls_aes_free(&aes);

    char type = (char)decrypted[0];

    // --- MOUSE LOGIC ---
    if (uuid == MOUSE_CHARACTERISTIC) {
        if (type == 'm') Mouse.move((int8_t)decrypted[1], (int8_t)decrypted[2]);
        else if (type == 'c') {
            if (decrypted[2] == 1) Mouse.press(decrypted[1]); else Mouse.release(decrypted[1]);
        }
        else if (type == 's') Mouse.move(0, 0, (int8_t)decrypted[1]);
    } 
    // --- KEYBOARD LOGIC ---
    else if (uuid == KEYBOARD_CHARACTERISTIC) {
        if (type == 'k') {
            uint8_t val = decrypted[1];
            uint8_t mode = decrypted[2]; // 0=ASCII, 1=Special, 3=Modifier Combo

            if (mode == 3) { // Modifier Combo (e.g. Ctrl+C)
                uint8_t modifier = decrypted[1]; 
                uint8_t key = decrypted[3];      
                Keyboard.press(modifier);
                Keyboard.press(key);
                delay(15);
                Keyboard.releaseAll();
            }
            else if (mode == 1) { // Special Keys (Switch case from old code)
                switch (val) {
                    case 8:  Keyboard.write(KEY_BACKSPACE); break;
                    case 9:  Keyboard.write(KEY_TAB); break;
                    case 13: Keyboard.write(KEY_RETURN); break;
                    case 27: Keyboard.write(KEY_ESC); break;
                    case 37: Keyboard.write(KEY_LEFT_ARROW); break;
                    case 38: Keyboard.write(KEY_UP_ARROW); break;
                    case 39: Keyboard.write(KEY_RIGHT_ARROW); break;
                    case 40: Keyboard.write(KEY_DOWN_ARROW); break;
                    case 46: Keyboard.write(KEY_DELETE); break;
                    default: if(val >= 112 && val <= 123) Keyboard.write(KEY_F1 + (val-112)); break;
                }
            } else {
                Keyboard.write((char)val);
            }
        }
    }
}

// 2. HID Input Callbacks
class MyHIDCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pC) { 
        decryptAndHandle(pC->getData(), pC->getLength(), pC->getUUID().toString()); 
    }
};

// 3. OTA Callbacks (Updated with original Serial reporting)
class MyOTACallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pC) {
        uint8_t* d = pC->getData(); size_t l = pC->getLength();
        if (l < 1) return;
        char cmd = (char)d[0];

        if (cmd == 'B') {
            uint32_t fileSize = *((uint32_t*)(d + 1));
            Serial.printf("OTA Begin: %u bytes\n", fileSize);
            Update.begin(fileSize);
        } else if (cmd == 'D') {
            Update.write(d + 1, l - 1);
        } else if (cmd == 'E') {
            if (Update.end(true)) {
                Serial.println("OTA Success. Rebooting...");
                delay(500);
                ESP.restart();
            } else {
                Serial.printf("OTA Error: %s\n", Update.errorString());
            }
        }
    }
};

void setup() {
    Serial.begin(115200);
    Mouse.begin(); Keyboard.begin(); USB.begin();

    BLEDevice::init("XIAO-Secure");
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());

    BLEService *pService = pServer->createService(SERVICE_UUID);

    // Create Characteristics with appropriate properties
    BLECharacteristic *mChar = pService->createCharacteristic(MOUSE_CHARACTERISTIC, BLECharacteristic::PROPERTY_WRITE_NR);
    BLECharacteristic *kChar = pService->createCharacteristic(KEYBOARD_CHARACTERISTIC, BLECharacteristic::PROPERTY_WRITE_NR);
    BLECharacteristic *otaChar = pService->createCharacteristic(OTA_CHARACTERISTIC, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_NOTIFY);

    mChar->setCallbacks(new MyHIDCallbacks());
    kChar->setCallbacks(new MyHIDCallbacks());
    otaChar->setCallbacks(new MyOTACallbacks());

    pService->start();

    // Advertising setup for Windows/Chrome/Mobile compatibility
    BLEAdvertising *pAdvertising = pServer->getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    pAdvertising->setMinPreferred(0x06);  
    pAdvertising->setMinPreferred(0x12);
    
    pAdvertising->start();
    Serial.println("XIAO-Secure Ready and Advertising...");
}

void loop() {
    delay(5); 
}
