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
let pendingPasteTimeout = null;

// --- OPTIMIZED DELAYS FOR RELIABILITY ---
const PASTE_DETECTION_DELAY = 150;
const BURST_TYPE_DELAY = 120;

// Constants for behavior
const TRACKPAD = { smoothing: 0.65, deadzone: 0.15, curveMid: 0.08, curveSharpness: 10 };
const SCROLL = { scale: 0.02, minStep: 0.05, maxSteps: 6 };

// --- Utility Delay ---
function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Acceleration helper for cursor movement
const accelCurve = (speed) =>
    1 + 1 / (1 + Math.exp(-TRACKPAD.curveSharpness * (speed - TRACKPAD.curveMid)));

// Curve helper for scrolling
const scrollCurve = (delta) => {
    const abs = Math.abs(delta);
    return abs < 10 ? abs * scrollBoost : abs;
};

// --- RELIABLE CTRL+V SEQUENCE ---
async function sendCtrlV() {
    // Ctrl Down
    sendEncrypted(keyChar, new Uint8Array([107, 0, 2, 0]));
    await delay(30);

    // V Down (with Ctrl held)
    sendEncrypted(keyChar, new Uint8Array([107, 118, 2, 0]));
    await delay(40);

    // V Up (Ctrl still held)
    sendEncrypted(keyChar, new Uint8Array([107, 0, 2, 0]));
    await delay(30);

    // Ctrl Up
    sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 0]));
}

// --- BURST PASTE (Ctrl + V + V) ---
async function burstClipboard() {
    const statusEl = document.getElementById("status");

    try {
        const rawText = await navigator.clipboard.readText();
        if (!rawText) return;

        const text = rawText.replace(/\r\n|\r/g, '\n');

        // Release everything first
        sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 0]));
        await delay(100);

        // Initial Ctrl+V
        await sendCtrlV();
        await delay(100);

        // Type contents manually
        for (let i = 0; i < text.length; i++) {
            let charCode = text.charCodeAt(i);

            if (statusEl)
                statusEl.innerText = `🚀 Sending: ${i + 1}/${text.length}`;

            if (text[i] === '\n') {
                sendEncrypted(keyChar, new Uint8Array([107, 13, 1, 1]));
                await delay(50);
                sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 0]));
                await delay(30);
            } else {
                sendEncrypted(keyChar, new Uint8Array([107, charCode, 0, 0]));
            }

            await delay(BURST_TYPE_DELAY);
        }

        if (statusEl) {
            statusEl.innerText = "Paste Complete!";
            setTimeout(() => {
                statusEl.innerText = "Connected";
            }, 2000);
        }

    } catch (err) {
        console.error("Clipboard error:", err);
        if (statusEl) statusEl.innerText = "Clipboard Error";
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

    const speed = Math.sqrt(rawX * rawX + rawY * rawY) / dt;
    smoothX = smoothX * TRACKPAD.smoothing + rawX * (1 - TRACKPAD.smoothing);
    smoothY = smoothY * TRACKPAD.smoothing + rawY * (1 - TRACKPAD.smoothing);

    if (Math.abs(smoothX) < TRACKPAD.deadzone) smoothX = 0;
    if (Math.abs(smoothY) < TRACKPAD.deadzone) smoothY = 0;

    const accel = accelCurve(speed);
    let outX = Math.round(smoothX * accel * mouseSensitivity);
    let outY = Math.round(smoothY * accel * mouseSensitivity);

    outX = Math.max(-127, Math.min(127, outX));
    outY = Math.max(-127, Math.min(127, outY));

    if (outX || outY)
        sendEncrypted(mouseChar, new Int8Array([109, outX, outY]));
});

// --- MOUSE CLICKS ---
document.addEventListener("mousedown", (e) => {
    if (document.pointerLockElement === document.getElementById("trackpad-card"))
        sendEncrypted(mouseChar, new Uint8Array([99, [1, 4, 2][e.button], 1]));
});

document.addEventListener("mouseup", (e) => {
    if (document.pointerLockElement === document.getElementById("trackpad-card"))
        sendEncrypted(mouseChar, new Uint8Array([99, [1, 4, 2][e.button], 0]));
});

// --- SCROLLING ---
document.addEventListener("wheel", (e) => {
    if (document.pointerLockElement !== document.getElementById("trackpad-card")) return;
    e.preventDefault();

    lastScrollTime = performance.now();
    let delta = e.deltaY;

    if (e.deltaMode === 1) delta *= 16;
    if (e.deltaMode === 2) delta *= 100;

    const curved = scrollCurve(delta) * SCROLL.scale;
    scrollRemainder += curved;

    let steps = Math.floor(Math.abs(scrollRemainder));
    if (steps === 0) return;

    steps = Math.min(steps, SCROLL.maxSteps);
    const direction = delta > 0 ? -1 : 1;
    scrollRemainder -= steps * Math.sign(scrollRemainder);

    for (let i = 0; i < steps; i++)
        sendEncrypted(mouseChar, new Int8Array([115, direction]));

}, { passive: false });

// --- KEYBOARD LOGIC ---
document.addEventListener("keydown", (e) => {
    const card = document.getElementById("trackpad-card");
    if (document.pointerLockElement !== card || !keyChar) return;

    // --- SMART PASTE DETECTION ---
    if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        const now = performance.now();
        e.preventDefault();
        e.stopPropagation();

        if (now - lastVTime < PASTE_DETECTION_DELAY) {
            clearTimeout(pendingPasteTimeout);
            lastVTime = 0;
            burstClipboard();
        } else {
            lastVTime = now;

            pendingPasteTimeout = setTimeout(async () => {
                await sendCtrlV();
                lastVTime = 0;
            }, PASTE_DETECTION_DELAY);
        }
        return;
    }

    let mod = 0;
    if (e.shiftKey) mod |= 1;
    if (e.ctrlKey) mod |= 2;
    if (e.altKey) mod |= 4;
    if (e.metaKey) mod |= 8;

    if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        sendEncrypted(keyChar, new Uint8Array([107, 128, 4, 96]));
        return;
    }

    if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        sendEncrypted(keyChar, new Uint8Array([107, 128, 4, 9]));
        return;
    }

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

    if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
        const mode = e.metaKey ? 4 : 3;
        const charCode = e.key.toLowerCase().charCodeAt(0);
        sendEncrypted(keyChar, new Uint8Array([107, 128, mode, charCode]));
        return;
    }

    const nav = {
        Backspace: 8, Tab: 9, Enter: 13, Escape: 27,
        ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
        Insert: 45, Delete: 46, Home: 36, End: 35,
        PageUp: 33, PageDown: 34,
        F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
        F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123
    };

    if (nav[e.key]) {
        sendEncrypted(keyChar, new Uint8Array([107, nav[e.key], 1, mod]));
        return;
    }

    if (e.key.length === 1)
        sendEncrypted(keyChar, new Uint8Array([107, e.key.charCodeAt(0), 0, mod]));
});

// --- SCROLL DECAY ---
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
