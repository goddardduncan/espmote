const UUIDS = {
    SERVICE: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
    MOUSE: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
    KEY: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
    OTA: "6e400004-b5a3-f393-e0a9-e50e24dcca9e",
};

let mouseChar, keyChar, otaChar, aesKeyParsed;

async function sendEncrypted(characteristic, dataArray) {
    if (!characteristic || !aesKeyParsed) return;
    const randomIV = CryptoJS.lib.WordArray.random(16);
    const wordArray = CryptoJS.lib.WordArray.create(dataArray);
    const encrypted = CryptoJS.AES.encrypt(wordArray, aesKeyParsed, {
        iv: randomIV,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
    });
    
    const ivBytes = Uint8Array.from(atob(randomIV.toString(CryptoJS.enc.Base64)), c => c.charCodeAt(0));
    const cipherBytes = Uint8Array.from(atob(encrypted.toString()), c => c.charCodeAt(0));
    
    const combined = new Uint8Array(ivBytes.length + cipherBytes.length);
    combined.set(ivBytes);
    combined.set(cipherBytes, ivBytes.length);

    try {
        await characteristic.writeValueWithoutResponse(combined);
    } catch (e) {
        console.error("Transmission Error:", e);
    }
}