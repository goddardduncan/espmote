const REPO_API_URL = "https://api.github.com/repos/goddardduncan/espmote/contents/firmware";
const RECONNECT_ATTEMPTS = 5;
let hasAttemptedConnection = false;
let bleDevice = null;
let reconnecting = false;
let selectedFileArray = null;

// --- Settings: restored from localStorage and saved on every change ---
// Runs as soon as the script loads, so it never waits on the page's fonts or the key lookup
const SLIDERS = [
    { id: "sensSlider",  out: "sensValue",      key: "mouseSensitivity", digits: 1, set: v => mouseSensitivity = v },
    { id: "scrollDecay", out: "scrollDecayVal", key: "scrollDecay",      digits: 2, set: v => scrollDecay = v },
    { id: "scrollBoost", out: "scrollBoostVal", key: "scrollBoost",      digits: 1, set: v => scrollBoost = v },
];

// localStorage can throw when site data is blocked; the settings then just last for the visit
function loadSetting(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function saveSetting(key, value) {
    try { localStorage.setItem(key, value); } catch {}
}

function initSettings() {
    SLIDERS.forEach(({ id, out, key, digits, set }) => {
        const slider = document.getElementById(id);
        const show = (v) => {
            set(v);
            document.getElementById(out).innerText = v.toFixed(digits);
        };

        const saved = parseFloat(loadSetting(key));
        if (!isNaN(saved)) {
            slider.value = saved;
            show(saved);
        }

        slider.addEventListener("input", () => {
            const v = parseFloat(slider.value);
            show(v);
            saveSetting(key, v);
        });
    });

    const invert = document.getElementById("invertScroll");
    invertScroll = invert.checked = loadSetting("invertScroll") === "true";
    invert.addEventListener("change", () => {
        invertScroll = invert.checked;
        saveSetting("invertScroll", invertScroll);
    });
}

initSettings();

window.onload = async () => {
    // 1. Check for saved keys in IndexedDB
    const savedKey = await getKeyFromDB();
    if (savedKey) {
        document.getElementById("aesKey").value = savedKey;
        document.getElementById("keyWrapper").style.display = "none";
        document.getElementById("confirmBtn").style.display = "none";
        document.getElementById("changeKeyBtn").style.display = "none";
        updateActiveKey();
    }
    
    // 2. Initialize all interactive UI elements
    initUIListeners();
};

function initUIListeners() {
    // --- Bluetooth Connection ---
    document.getElementById("connectBtn").onclick = async () => {
        if (!updateActiveKey()) {
            alert("Please enter a valid 16-character AES key first.");
            return;
        }

        document.getElementById("status").innerText = "Requesting device...";

        try {
            const device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: "XIAO-" },
                    { namePrefix: "nimble" } 
                ],
                optionalServices: [UUIDS.SERVICE],
            });

            document.getElementById("status").innerText = "Connecting...";
            bleDevice = device;
            device.ongattserverdisconnected = reconnect;
            await connectGatt(device);

            document.getElementById("status").innerText = "Connected";
            document.getElementById("connectBtn").style.display = "none";
            document.getElementById("ota-panel").style.display = "block";

            if (!hasAttemptedConnection) loadGitHubFiles();
            hasAttemptedConnection = true;

        } catch (e) {
            console.error(e);
            document.getElementById("status").innerText = "Error: " + e.message;
        }
    };

    // --- Key Management ---
    document.getElementById("togglePass").onclick = () => {
        const input = document.getElementById("aesKey");
        input.type = input.type === "password" ? "text" : "password";
    };

    document.getElementById("confirmBtn").onclick = async () => {
        const val = document.getElementById("aesKey").value;
        if (val.length === 16) {
            await saveKeyToDB(val);
            document.getElementById("keyWrapper").style.display = "none";
            document.getElementById("confirmBtn").style.display = "none";
            document.getElementById("changeKeyBtn").style.display = "none";
            alert("Key saved to secure storage.");
        } else {
            alert("Key must be exactly 16 characters.");
        }
    };

    document.getElementById("changeKeyBtn").onclick = () => {
        if (updateActiveKey()) {
            const btn = document.getElementById("changeKeyBtn");
            const originalText = btn.innerText;
            btn.innerText = "Key Updated!";
            setTimeout(() => (btn.innerText = originalText), 1500);
        }
    };

    // --- Trackpad Activation ---
    const card = document.getElementById("trackpad-card");
    card.onclick = function() {
        if (mouseChar) this.requestPointerLock();
    };

    document.addEventListener("pointerlockchange", () => {
        const locked = document.pointerLockElement === card;
        card.classList.toggle("active", locked);
        document.getElementById("instr").innerText = locked ? "Mode: Active" : "Tap to control device";
        
        // Show setup buttons only when trackpad is NOT active
        const isKeySaved = document.getElementById("keyWrapper").style.display === "none";
        if (!locked && hasAttemptedConnection && !isKeySaved) {
            document.getElementById("changeKeyBtn").style.display = "inline-block";
            document.getElementById("confirmBtn").style.display = "inline-block";
        } else {
            document.getElementById("changeKeyBtn").style.display = "none";
            document.getElementById("confirmBtn").style.display = "none";
        }
    });

    // --- OTA Firmware Panel ---
    document.getElementById("otaToggle").onclick = () => {
        const c = document.getElementById("ota-controls");
        c.style.display = c.style.display === "flex" ? "none" : "flex";
    };

    document.getElementById("resetBtn").onclick = resetApp;
}

async function connectGatt(device) {
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(UUIDS.SERVICE);

    // Assign global characteristics defined in ble.js
    mouseChar = await service.getCharacteristic(UUIDS.MOUSE);
    keyChar = await service.getCharacteristic(UUIDS.KEY);
    otaChar = await service.getCharacteristic(UUIDS.OTA);
}

// Reconnect to the same device without the chooser (also picks the board back up after an OTA reboot)
async function reconnect() {
    if (reconnecting) return;
    reconnecting = true;
    mouseChar = keyChar = otaChar = null;
    releaseAll(); // the firmware has already released everything on its side

    const status = document.getElementById("status");
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
        status.innerText = `Reconnecting (${attempt}/${RECONNECT_ATTEMPTS})...`;
        await new Promise(r => setTimeout(r, 1000 * attempt));
        try {
            await connectGatt(bleDevice);
            status.innerText = "Connected";
            reconnecting = false;
            return;
        } catch (e) {
            console.warn("Reconnect failed:", e);
        }
    }

    reconnecting = false;
    status.innerText = "Disconnected";
    document.getElementById("connectBtn").style.display = "inline-block";
}

function updateActiveKey() {
    const val = document.getElementById("aesKey").value;
    if (val.length !== 16) return false;
    aesKeyParsed = CryptoJS.enc.Utf8.parse(val);
    return true;
}

// --- GitHub Firmware Loader ---
async function loadGitHubFiles() {
    try {
        const res = await fetch(REPO_API_URL);
        const files = await res.json();
        const list = document.getElementById("fileList");
        list.innerHTML = "";
        
        files.filter(f => f.name.endsWith(".bin")).forEach(file => {
            const div = document.createElement("div");
            div.className = "file-item";
            div.innerHTML = `<span>📦 ${file.name}</span>`;
            
            div.onclick = async () => {
                document.getElementById("otaStatus").innerText = "Downloading...";
                document.getElementById("updateBtn").disabled = true;
                
                const fRes = await fetch(file.download_url);
                selectedFileArray = new Uint8Array(await fRes.arrayBuffer());
                
                document.getElementById("otaStatus").innerText = `Ready: ${file.name}`;
                document.getElementById("updateBtn").disabled = false;
                
                Array.from(list.children).forEach(c => c.classList.remove("selected"));
                div.classList.add("selected");
            };
            list.appendChild(div);
        });
    } catch (e) { 
        document.getElementById("fileList").innerText = "Error loading builds."; 
    }
}

// --- OTA Update Trigger ---
document.getElementById("updateBtn").onclick = async () => {
    if (!selectedFileArray || !otaChar || !aesKeyParsed) return;

    const pBar = document.getElementById("pBar");
    const pFill = document.getElementById("pFill");
    pBar.style.display = "block";

    // Every OTA message is encrypted with the same key as HID traffic
    try {
        // Start Message: 'B' + Size (4 bytes)
        const beginMsg = new Uint8Array(5);
        beginMsg[0] = 66;
        new DataView(beginMsg.buffer).setUint32(1, selectedFileArray.length, true);
        await otaChar.writeValue(encryptPacket(beginMsg));

        // Chunk Data: 'D' + 128 bytes
        for (let i = 0; i < selectedFileArray.length; i += 128) {
            const chunk = selectedFileArray.slice(i, i + 128);
            const dataMsg = new Uint8Array(chunk.length + 1);
            dataMsg[0] = 68;
            dataMsg.set(chunk, 1);

            await otaChar.writeValue(encryptPacket(dataMsg));

            let pct = Math.round((i / selectedFileArray.length) * 100);
            pFill.style.width = pct + "%";
            document.getElementById("otaStatus").innerText = `Updating: ${pct}%`;
        }

        // End Message: 'E'
        await otaChar.writeValue(encryptPacket(new Uint8Array([69])));
        document.getElementById("otaStatus").innerText = "Success! Rebooting...";
    } catch (e) {
        console.error("OTA Error:", e);
        document.getElementById("otaStatus").innerText = "Update failed: " + e.message;
    }
};
