const dbName = "XiaoSecureDB";
const storeName = "KeyStore";

async function openDB() {
    return new Promise((resolve) => {
        let request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(storeName);
        request.onsuccess = () => resolve(request.result);
    });
}

async function saveKeyToDB(keyStr) {
    const db = await openDB();
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(keyStr, "user_aes_key");
}

async function getKeyFromDB() {
    const db = await openDB();
    return new Promise((resolve) => {
        const req = db.transaction(storeName).objectStore(storeName).get("user_aes_key");
        req.onsuccess = () => resolve(req.result);
    });
}

function resetApp() {
    indexedDB.deleteDatabase(dbName);
    location.reload();
}