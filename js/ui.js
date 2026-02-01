const REPO_API_URL = "https://api.github.com/repos/goddardduncan/espmote/contents/firmware";
let hasAttemptedConnection = false;
let selectedFileArray = null;

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
                filters: [{ namePrefix: "XIAO-" }],
                optionalServices: [UUIDS.SERVICE],
            });

            document.getElementById("status").innerText = "Connecting...";
            const server = await device.gatt.connect();
            const service = await server.getPrimaryService(UUIDS.SERVICE);
            
            // Assign global characteristics defined in ble.js
            mouseChar = await service.getCharacteristic(UUIDS.MOUSE);
            keyChar = await service.getCharacteristic(UUIDS.KEY);
            otaChar = await service.getCharacteristic(UUIDS.OTA);

            document.getElementById("status").innerText = "Connected";
            document.getElementById("connectBtn").style.display = "none";
            document.getElementById("ota-panel").style.display = "block";
            
            hasAttemptedConnection = true;
            loadGitHubFiles();

            device.addEventListener("gattserverdisconnected", () => {
                document.getElementById("status").innerText = "Disconnected. Reloading...";
                setTimeout(() => location.reload(), 1500);
            });

        } catch (e) {
            console.error(e);
            document.getElementById("status").innerText = "Error: " + e.message;
        }
    };

    // --- Sliders (Mouse & Scroll) ---
    const s = document.getElementById("sensSlider");
    s.oninput = (e) => {
        mouseSensitivity = parseFloat(e.target.value);
        document.getElementById("sensValue").innerText = mouseSensitivity.toFixed(1);
        localStorage.setItem("mouseSensitivity", mouseSensitivity);
    };

    const d = document.getElementById("scrollDecay");
    d.oninput = (e) => {
        scrollDecay = parseFloat(e.target.value);
        document.getElementById("scrollDecayVal").innerText = scrollDecay.toFixed(3);
        localStorage.setItem("scrollDecay", scrollDecay);
    };

    const b = document.getElementById("scrollBoost");
    b.oninput = (e) => {
        scrollBoost = parseFloat(e.target.value);
        document.getElementById("scrollBoostVal").innerText = scrollBoost.toFixed(1);
        localStorage.setItem("scrollBoost", scrollBoost);
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
    if (!selectedFileArray || !otaChar) return;
    
    const pBar = document.getElementById("pBar");
    const pFill = document.getElementById("pFill");
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
        document.getElementById("otaStatus").innerText = `Updating: ${pct}%`;
    }
    
    // End Message: 'E'
    await otaChar.writeValue(new Uint8Array([69])); 
    document.getElementById("otaStatus").innerText = "Success! Rebooting...";
};
