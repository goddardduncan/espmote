// Local variables for mouse and scroll state
let mouseSensitivity = parseFloat(localStorage.getItem("mouseSensitivity")) || 2.0;
let scrollDecay = parseFloat(localStorage.getItem("scrollDecay")) || 0.95;
let scrollBoost = parseFloat(localStorage.getItem("scrollBoost")) || 1.4;

let lastMoveTime = performance.now();
let smoothX = 0, smoothY = 0;
let scrollRemainder = 0, lastScrollTime = 0;
let tickCount = 0, tickTime;

// Burst Paste State
let lastVTime = 0;
const BURST_DELAY = 75; // 75ms ensures ESP32 decryption and OS HID processing stability

// Constants for behavior
const TRACKPAD = { smoothing: 0.65, deadzone: 0.15, curveMid: 0.08, curveSharpness: 10 };
const SCROLL = { scale: 0.02, minStep: 0.05, maxSteps: 6 };

// Acceleration helper for cursor movement
const accelCurve = (speed) => 1 + 1 / (1 + Math.exp(-TRACKPAD.curveSharpness * (speed - TRACKPAD.curveMid)));

// Curve helper for scrolling
const scrollCurve = (delta) => {
    const abs = Math.abs(delta);
    return abs < 10 ? abs * scrollBoost : abs;
};

// --- BURST PASTE (Ctrl + V + V) ---
async function burstClipboard() {
    try {
        const rawText = await navigator.clipboard.readText();
        if (!rawText) return;

        // Normalize all line breaks
        const normalizedText = rawText.replace(/\r\n|\r/g, '\n');

        const statusEl = document.getElementById("status");
        const originalStatus = statusEl.innerText;

        for (let i = 0; i < normalizedText.length; i++) {
            let char = normalizedText[i];
            let charCode = char.charCodeAt(0);
            
            statusEl.innerText = `🚀 Sending: ${i + 1}/${normalizedText.length}`;

            if (charCode === 10) {
                console.log("Newline Detected: Executing Robust Shift+Enter Hold");
                
                // 1. PRESS SHIFT
                sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 1])); 
                await new Promise(r => setTimeout(r, 30));
                
                // 2. PRESS ENTER (With Shift still active)
                sendEncrypted(keyChar, new Uint8Array([107, 13, 0, 1]));
                await new Promise(r => setTimeout(r, 40));

                // 3. RELEASE ENTER (Keep Shift active for a moment)
                sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 1]));
                await new Promise(r => setTimeout(r, 20));

                // 4. RELEASE SHIFT (Final clean state)
                sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 0]));
            } else {
                // Normal Typing
                sendEncrypted(keyChar, new Uint8Array([107, charCode, 0, 0]));
            }
            
            await new Promise(r => setTimeout(r, BURST_DELAY));
        }

        statusEl.innerText = "Paste Complete!";
        setTimeout(() => { statusEl.innerText = "Connected"; }, 2000);
    } catch (err) {
        console.error("Clipboard error:", err);
        document.getElementById("status").innerText = "Clipboard Error";
    }
}

// --- MOUSE MOVEMENT ---
document.addEventListener("mousemove", (e) => {
    const card = document.getElementById("trackpad-card");
    if (document.pointerLockElement !== card) return;

    const now = performance.now();
    const dt = Math.max(now - lastMoveTime, 1);
    lastMoveTime = now;

    const rawX = e.movementX;
    const rawY = e.movementY;

    // Velocity-based smoothing and acceleration
    const speed = Math.sqrt(rawX * rawX + rawY * rawY) / dt;
    smoothX = smoothX * TRACKPAD.smoothing + rawX * (1 - TRACKPAD.smoothing);
    smoothY = smoothY * TRACKPAD.smoothing + rawY * (1 - TRACKPAD.smoothing);

    if (Math.abs(smoothX) < TRACKPAD.deadzone) smoothX = 0;
    if (Math.abs(smoothY) < TRACKPAD.deadzone) smoothY = 0;

    const accel = accelCurve(speed);
    let outX = Math.round(smoothX * accel * mouseSensitivity);
    let outY = Math.round(smoothY * accel * mouseSensitivity);

    // HID safety clamp
    outX = Math.max(-127, Math.min(127, outX));
    outY = Math.max(-127, Math.min(127, outY));

    if (outX || outY) {
        sendEncrypted(mouseChar, new Int8Array([109, outX, outY]));
    }
});

// --- MOUSE CLICKS & DRAGGING ---
document.addEventListener("mousedown", (e) => {
    if (document.pointerLockElement === document.getElementById("trackpad-card"))
        // Sends '1' for Button Down - starts a click or drag
        sendEncrypted(mouseChar, new Uint8Array([99, [1, 4, 2][e.button], 1]));
});

document.addEventListener("mouseup", (e) => {
    if (document.pointerLockElement === document.getElementById("trackpad-card"))
        // Sends '0' for Button Up - finishes the click or drag
        sendEncrypted(mouseChar, new Uint8Array([99, [1, 4, 2][e.button], 0]));
});

// --- SCROLLING ---
document.addEventListener("wheel", (e) => {
    if (document.pointerLockElement !== document.getElementById("trackpad-card")) return;
    e.preventDefault();

    lastScrollTime = performance.now();
    let delta = e.deltaY;

    // Normalize different browser wheel modes
    if (e.deltaMode === 1) delta *= 16;
    if (e.deltaMode === 2) delta *= 100;

    const curved = scrollCurve(delta) * SCROLL.scale;
    scrollRemainder += curved;

    let steps = Math.floor(Math.abs(scrollRemainder));
    if (steps === 0) return;

    steps = Math.min(steps, SCROLL.maxSteps);
    const direction = delta > 0 ? -1 : 1;
    scrollRemainder -= steps * Math.sign(scrollRemainder);

    for (let i = 0; i < steps; i++) {
        sendEncrypted(mouseChar, new Int8Array([115, direction]));
    }
}, { passive: false });

// --- KEYBOARD LOGIC ---
document.addEventListener("keydown", (e) => {
    const card = document.getElementById("trackpad-card");
    if (document.pointerLockElement !== card || !keyChar) return;

    // 1. BURST PASTE DETECTION (Double-tap V while holding Ctrl)
    if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        const now = performance.now();
        if (now - lastVTime < 500) {
            e.preventDefault();
            lastVTime = 0; 
            burstClipboard();
            return;
        }
        lastVTime = now;
    }

    // 2. Modifiers bitmask
    let mod = 0;
    if (e.shiftKey) mod |= 1;
    if (e.ctrlKey) mod |= 2;
    if (e.altKey) mod |= 4;
    if (e.metaKey) mod |= 8;

    // 3. OS-LEVEL INTERRUPT REMAPS
    if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        sendEncrypted(keyChar, new Uint8Array([107, 128, 4, 96])); // Switch window
        return;
    }
    if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        sendEncrypted(keyChar, new Uint8Array([107, 128, 4, 9])); // Tab switch
        return;
    }

    // 4. ESCAPE LOGIC (3x ` -> ESC)
    if (e.key === "`") {
        e.preventDefault();
        tickCount++;
        clearTimeout(tickTime);
        if (tickCount === 3) {
            sendEncrypted(keyChar, new Uint8Array([107, 27, 1, 0]));
            tickCount = 0;
        } else {
            tickTime = setTimeout(() => {
                if (tickCount === 1)
                    sendEncrypted(keyChar, new Uint8Array([107, 96, 0, mod]));
                tickCount = 0;
            }, 500);
        }
        return;
    }

    e.preventDefault();

    // 5. SHORTCUTS (Ctrl/Cmd + Key)
    if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
        const mode = e.metaKey ? 4 : 3;
        const charCode = e.key.toLowerCase().charCodeAt(0);
        sendEncrypted(keyChar, new Uint8Array([107, 128, mode, charCode]));
        return;
    }

    // 6. NAVIGATION & FUNCTION KEYS
    const nav = {
        Backspace: 8, Tab: 9, Enter: 13, ArrowLeft: 37, ArrowUp: 38,
        ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
        Home: 36, End: 35, PageUp: 33, PageDown: 34,
        F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
        F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123
    };

    if (nav[e.key]) {
        sendEncrypted(keyChar, new Uint8Array([107, nav[e.key], 1, mod]));
        return;
    }

    // 7. PLAIN TYPING
    if (e.key.length === 1) {
        sendEncrypted(keyChar, new Uint8Array([107, e.key.charCodeAt(0), 0, mod]));
    }
});

// --- SCROLL DECAY ANIMATION ---
function decayScrollRemainder() {
    const now = performance.now();
    if (now - lastScrollTime > 40 && scrollRemainder !== 0) {
        const dt = now - lastScrollTime;
        scrollRemainder *= Math.pow(scrollDecay, dt / 16);
        if (Math.abs(scrollRemainder) < 0.01) scrollRemainder = 0;
    }
    requestAnimationFrame(decayScrollRemainder);
}

decayScrollRemainder();
