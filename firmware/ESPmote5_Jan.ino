#include "USB.h"
#include "USBHIDMouse.h"
#include "USBHIDKeyboard.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Update.h>

USBHIDMouse Mouse;
USBHIDKeyboard Keyboard;

// UUIDs - Must match the HTML app
#define SERVICE_UUID           "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define MOUSE_CHARACTERISTIC   "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define KEYBOARD_CHARACTERISTIC "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
#define OTA_CHARACTERISTIC     "6e400004-b5a3-f393-e0a9-e50e24dcca9e"

BLEServer* pServer = NULL;
bool deviceConnected = false;

// 1. Server Callbacks: Handles Browser Refresh/Disconnect
class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) {
        deviceConnected = true;
        Serial.println("Browser connected.");
    };

    void onDisconnect(BLEServer* pServer) {
        deviceConnected = false;
        Serial.println("Browser disconnected. Restarting Advertising...");
        // This allows the device to show up in the pairing list again immediately
        pServer->getAdvertising()->start();
    }
};

// 2. Mouse & Keyboard Callbacks: Handles HID Input
class MyHIDCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
        uint8_t* data = pCharacteristic->getData();
        size_t len = pCharacteristic->getLength();
        if (len < 2) return;

        char type = (char)data[0];

        // Mouse Logic
        if (pCharacteristic->getUUID().toString() == MOUSE_CHARACTERISTIC) {
            if (type == 'm' && len >= 3) Mouse.move((int8_t)data[1], (int8_t)data[2]);
            else if (type == 'c' && len >= 3) {
                if (data[2] == 1) Mouse.press(data[1]); else Mouse.release(data[1]);
            }
            else if (type == 's' && len >= 2) Mouse.move(0, 0, (int8_t)data[1]);
        } 
        // Keyboard Logic
        else if (pCharacteristic->getUUID().toString() == KEYBOARD_CHARACTERISTIC) {
            if (type == 'k' && len >= 3) {
                uint8_t keyVal = data[1];
                uint8_t isSpecial = data[2]; // 0=ASCII, 1=Special/HID, 2=Media

                if (isSpecial == 1) {
                    switch (keyVal) {
                        case 8:  Keyboard.write(KEY_BACKSPACE); break;
                        case 9:  Keyboard.write(KEY_TAB); break;
                        case 13: Keyboard.write(KEY_RETURN); break;
                        case 27: Keyboard.write(KEY_ESC); break;
                        case 37: Keyboard.write(KEY_LEFT_ARROW); break;
                        case 38: Keyboard.write(KEY_UP_ARROW); break;
                        case 39: Keyboard.write(KEY_RIGHT_ARROW); break;
                        case 40: Keyboard.write(KEY_DOWN_ARROW); break;
                        case 46: Keyboard.write(KEY_DELETE); break;
                        default: if(keyVal >= 112 && keyVal <= 123) Keyboard.write(KEY_F1 + (keyVal-112)); break;
                    }
                } else {
                    Keyboard.write((char)keyVal);
                }
            }
        }
    }
};

// 3. OTA Callbacks: Handles Firmware Updates
class MyOTACallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pCharacteristic) {
        uint8_t* data = pCharacteristic->getData();
        size_t len = pCharacteristic->getLength();
        if (len < 1) return;

        char cmd = (char)data[0];

        if (cmd == 'B') { // BEGIN
            uint32_t fileSize = *((uint32_t*)(data + 1));
            Serial.printf("OTA Start: %u bytes\n", fileSize);
            if (Update.begin(fileSize)) {
                // Flash ready
            }
        } 
        else if (cmd == 'D') { // DATA
            Update.write(data + 1, len - 1);
        } 
        else if (cmd == 'E') { // END
            if (Update.end(true)) {
                Serial.println("OTA Success! Rebooting...");
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
    
    // Initialize USB HID
    Mouse.begin(); 
    Keyboard.begin(); 
    USB.begin();

    // Initialize BLE
    BLEDevice::init("XIAO-Chromeo");
    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());

    BLEService *pService = pServer->createService(SERVICE_UUID);

    // Mouse Characteristic
    BLECharacteristic *mChar = pService->createCharacteristic(
        MOUSE_CHARACTERISTIC, 
        BLECharacteristic::PROPERTY_WRITE_NR
    );
    
    // Keyboard Characteristic
    BLECharacteristic *kChar = pService->createCharacteristic(
        KEYBOARD_CHARACTERISTIC, 
        BLECharacteristic::PROPERTY_WRITE_NR
    );

    // OTA Characteristic (Requires Write with Response for reliability)
    BLECharacteristic *otaChar = pService->createCharacteristic(
        OTA_CHARACTERISTIC,
        BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_NOTIFY
    );

    // Assign Callbacks
    MyHIDCallbacks* hidHandler = new MyHIDCallbacks();
    mChar->setCallbacks(hidHandler);
    kChar->setCallbacks(hidHandler);
    otaChar->setCallbacks(new MyOTACallbacks());

    pService->start();

    // Configure Advertising for maximum compatibility
    BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    
    // Helps with fast discovery on Windows/Chrome
    pAdvertising->setMinPreferred(0x06);  
    pAdvertising->setMinPreferred(0x12);
    
    pServer->getAdvertising()->start();
    Serial.println("XIAO-Chromeo Ready to Pair");
}

void loop() {
    // Keep loop empty and non-blocking for USB/BLE stability
    delay(10); 
}