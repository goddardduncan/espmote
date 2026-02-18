// js/ui.js

// Load saved values on page startup
let mouseSensitivity = parseFloat(localStorage.getItem("mouseSensitivity")) || 2.0;
let scrollDecay = parseFloat(localStorage.getItem("scrollDecay")) || 0.95;
let scrollBoost = parseFloat(localStorage.getItem("scrollBoost")) || 1.4;
let aesKeyParsed = null;

// --- Helper function to ensure DOM elements exist ---
function getElement(id) {
    const el = document.getElementById(id);
    if (!el) console.error(`Element not found: ${id}`);
    return el;
}

window.onload = async () => {
    console.log("UI Loading...");

    // 1. Set Slider UI to match loaded values
    getElement("sensSlider").value = mouseSensitivity;
    getElement("sensValue").innerText = mouseSensitivity.toFixed(1);
    
    getElement("scrollDecay").value = scrollDecay;
    getElement("scrollDecayVal").innerText = scrollDecay.toFixed(3);
    
    getElement("scrollBoost").value = scrollBoost;
    getElement("scrollBoostVal").innerText = scrollBoost.toFixed(1);

    // 2. Check for saved keys in IndexedDB
    const savedKey = await getKeyFromDB();
    if (savedKey) {
        getElement("aesKey").value = savedKey;
        getElement("keyWrapper").style.display = "none";
        getElement("confirmBtn").style.display = "none";
        getElement("changeKeyBtn").style.display = "none";
        updateActiveKey();
    }
    
    // 3. Initialize all interactive UI elements
    initUIListeners();
    console.log("UI Loaded.");
};

function initUIListeners() {
    // --- Bluetooth Connection ---
    getElement("connectBtn").onclick = async () => {
        if (!updateActiveKey()) {
            alert("Please enter a valid 16-character AES key first.");
            return;
        }

        getElement("status").innerText = "Requesting device...";

        try {
            const device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: "XIAO-" },
                    { namePrefix: "nimble" } 
                ],
                optionalServices: [UUIDS.SERVICE],
            });

            getElement("status").innerText = "Connecting...";
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(UUIDS.SERVICE);
            
            // Assign global characteristics defined in ble.js
            mouseChar = await service.getCharacteristic(UUIDS.MOUSE);
            keyChar = await service.getCharacteristic(UUIDS.KEY);
            otaChar = await service.getCharacteristic(UUIDS.OTA);

            getElement("status").innerText = "Connected";
            getElement("connectBtn").style.display = "none";
            getElement("ota-panel").style.display = "block";
            
            hasAttemptedConnection = true;
            loadGitHubFiles();

            device.addEventListener("gattserverdisconnected", () => {
                getElement("status").innerText = "Disconnected. Reloading...";
                setTimeout(() => location.reload(), 1500);
            });

        } catch (e) {
            console.error(e);
            getElement("status").innerText = "Error: " + e.message;
        }
    };

    // --- Sliders (Mouse & Scroll) ---
    const s = getElement("sensSlider");
    if (s) {
        s.addEventListener("input", (e) => {
            mouseSensitivity = parseFloat(e.target.value);
            getElement("sensValue").innerText = mouseSensitivity.toFixed(1);
            localStorage.setItem("mouseSensitivity", mouseSensitivity);
            console.log("Sensitivity:", mouseSensitivity);
        });
    }

    const d = getElement("scrollDecay");
    if (d) {
        d.addEventListener("input", (e) => {
            scrollDecay = parseFloat(e.target.value);
            getElement("scrollDecayVal").innerText = scrollDecay.toFixed(3);
            localStorage.setItem("scrollDecay", scrollDecay);
            console.log("Decay:", scrollDecay);
        });
    }

    const b = getElement("scrollBoost");
    if (b) {
        b.addEventListener("input", (e) => {
            scrollBoost = parseFloat(e.target.value);
            getElement("scrollBoostVal").innerText = scrollBoost.toFixed(1);
            localStorage.setItem("scrollBoost", scrollBoost);
            console.log("Boost:", scrollBoost);
        });
    }

    // --- Key Management ---
    getElement("togglePass").onclick = () => {
        const input = getElement("aesKey");
        input.type = input.type === "password" ? "text" : "password";
    };

    getElement("confirmBtn").onclick = async () => {
        const val = getElement("aesKey").value;
        if (val.length === 16) {
            await saveKeyToDB(val);
            getElement("keyWrapper").style.display = "none";
            getElement("confirmBtn").style.display = "none";
            getElement("changeKeyBtn").style.display = "none";
            alert("Key saved to secure storage.");
        } else {
            alert("Key must be exactly 16 characters.");
        }
    };

    getElement("changeKeyBtn").onclick = () => {
        if (updateActiveKey()) {
            const btn = getElement("changeKeyBtn");
            const originalText = btn.innerText;
            btn.innerText = "Key Updated!";
            setTimeout(() => (btn.innerText = originalText), 1500);
        }
    };

    // --- Trackpad Activation ---
    const card = getElement("trackpad-card");
    card.onclick = function() {
        if (typeof mouseChar !== 'undefined' && mouseChar) this.requestPointerLock();
    };

    document.addEventListener("pointerlockchange", () => {
        const locked = document.pointerLockElement === card;
        card.classList.toggle("active", locked);
        getElement("instr").innerText = locked ? "Mode: Active" : "Tap to control device";
        
        // Show setup buttons only when trackpad is NOT active
        const keyWrapper = getElement("keyWrapper");
        const isKeySaved = keyWrapper.style.display === "none";
        
        if (!locked && hasAttemptedConnection && !isKeySaved) {
            getElement("changeKeyBtn").style.display = "inline-block";
            getElement("confirmBtn").style.display = "inline-block";
        } else {
            getElement("changeKeyBtn").style.display = "none";
            getElement("confirmBtn").style.display = "none";
        }
    });

    // --- OTA Firmware Panel ---
    getElement("otaToggle").onclick = () => {
        const c = getElement("ota-controls");
        c.style.display = c.style.display === "flex" ? "none" : "flex";
    };

    getElement("resetBtn").onclick = () => {
        if(typeof resetApp === 'function') resetApp();
    };
}

function updateActiveKey() {
    const val = getElement("aesKey").value;
    if (val.length !== 16) return false;
    if (typeof CryptoJS !== 'undefined') {
        aesKeyParsed = CryptoJS.enc.Utf8.parse(val);
        return true;
    }
    return false;
}

// --- GitHub Firmware Loader ---
async function loadGitHubFiles() {
    try {
        const res = await fetch(REPO_API_URL);
        const files = await res.json();
        const list = getElement("fileList");
        list.innerHTML = "";
        
        files.filter(f => f.name.endsWith(".bin")).forEach(file => {
            const div = document.createElement("div");
            div.className = "file-item";
            div.innerHTML = `<span>📦 ${file.name}</span>`;
            
            div.onclick = async () => {
                getElement("otaStatus").innerText = "Downloading...";
                getElement("updateBtn").disabled = true;
                
                const fRes = await fetch(file.download_url);
                selectedFileArray = new Uint8Array(await fRes.arrayBuffer());
                
                getElement("otaStatus").innerText = `Ready: ${file.name}`;
                getElement("updateBtn").disabled = false;
                
                Array.from(list.children).forEach(c => c.classList.remove("selected"));
                div.classList.add("selected");
            };
            list.appendChild(div);
        });
    } catch (e) { 
        getElement("fileList").innerText = "Error loading builds."; 
    }
}

// --- OTA Update Trigger ---
getElement("updateBtn").onclick = async () => {
    if (!selectedFileArray || typeof otaChar === 'undefined' || !otaChar) return;
    
    const pBar = getElement("pBar");
    const pFill = getElement("pFill");
    pBar.style.display = "block";
    
    // Start Message: 'B' + Size (4 bytes)
    const beginMsg = new Uint8Array(5);
    beginMsg[0] = 66; 
    new DataView(beginMsg.buffer).setUint32(1, selectedFileArray.length, true);
    await otaChar.writeValue(beginMsg);

    // Chunk Data: 'D' + 128 bytes
    for (let i = 0; i < selectedFileArray.length; i += 128) {
        const chunk = selectedFileArray.slice(i, i + 128);
        const dataMsg = new Uint8Array(chunk.length + 1);
        dataMsg[0] = 68; 
        dataMsg.set(chunk, 1);
        
        await otaChar.writeValue(dataMsg);
        
        let pct = Math.round((i / selectedFileArray.length) * 100);
        pFill.style.width = pct + "%";
        getElement("otaStatus").innerText = `Updating: ${pct}%`;
    }
    
    // End Message: 'E'
    await otaChar.writeValue(new Uint8Array([69])); 
    getElement("otaStatus").innerText = "Success! Rebooting...";
};
