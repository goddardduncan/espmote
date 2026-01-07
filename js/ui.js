const REPO_API_URL = "https://api.github.com/repos/goddardduncan/espmote/contents/firmware";
let hasAttemptedConnection = false;
let selectedFileArray = null;

window.onload = async () => {
    const savedKey = await getKeyFromDB();
    if (savedKey) {
        document.getElementById("aesKey").value = savedKey;
        document.getElementById("keyWrapper").style.display = "none";
        document.getElementById("confirmBtn").style.display = "none";
        updateActiveKey();
    }
    initUIListeners();
};

function initUIListeners() {
    // Sliders
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

    // Buttons
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
            alert("Key saved.");
        }
    };

    document.getElementById("trackpad-card").onclick = function() {
        if (mouseChar) this.requestPointerLock();
    };

    document.addEventListener("pointerlockchange", () => {
        const locked = document.pointerLockElement === document.getElementById("trackpad-card");
        document.getElementById("trackpad-card").classList.toggle("active", locked);
        document.getElementById("instr").innerText = locked ? "Mode: Active" : "Tap to control device";
        
        if (!locked && hasAttemptedConnection && document.getElementById("keyWrapper").style.display !== "none") {
            document.getElementById("changeKeyBtn").style.display = "inline-block";
            document.getElementById("confirmBtn").style.display = "inline-block";
        } else {
            document.getElementById("changeKeyBtn").style.display = "none";
            document.getElementById("confirmBtn").style.display = "none";
        }
    });

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
                const fRes = await fetch(file.download_url);
                selectedFileArray = new Uint8Array(await fRes.arrayBuffer());
                document.getElementById("otaStatus").innerText = `Ready: ${file.name}`;
                document.getElementById("updateBtn").disabled = false;
                Array.from(list.children).forEach(c => c.classList.remove("selected"));
                div.classList.add("selected");
            };
            list.appendChild(div);
        });
    } catch (e) { list.innerText = "Error loading builds."; }
}

document.getElementById("updateBtn").onclick = async () => {
    if (!selectedFileArray || !otaChar) return;
    const pBar = document.getElementById("pBar");
    const pFill = document.getElementById("pFill");
    pBar.style.display = "block";
    
    const beginMsg = new Uint8Array(5);
    beginMsg[0] = 66; // 'B'
    new DataView(beginMsg.buffer).setUint32(1, selectedFileArray.length, true);
    await otaChar.writeValue(beginMsg);

    for (let i = 0; i < selectedFileArray.length; i += 128) {
        const chunk = selectedFileArray.slice(i, i + 128);
        const dataMsg = new Uint8Array(chunk.length + 1);
        dataMsg[0] = 68; // 'D'
        dataMsg.set(chunk, 1);
        await otaChar.writeValue(dataMsg);
        let pct = Math.round((i / selectedFileArray.length) * 100);
        pFill.style.width = pct + "%";
        document.getElementById("otaStatus").innerText = `Updating: ${pct}%`;
    }
    await otaChar.writeValue(new Uint8Array([69])); // 'E'
    document.getElementById("otaStatus").innerText = "Success! Rebooting...";
};