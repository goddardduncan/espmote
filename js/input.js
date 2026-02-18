// Local variables for mouse and scroll state
let mouseSensitivity = parseFloat(localStorage.getItem("mouseSensitivity")) || 2.0;
let scrollDecay = parseFloat(localStorage.getItem("scrollDecay")) || 0.95;
let scrollBoost = parseFloat(localStorage.getItem("scrollBoost")) || 1.4;

let lastMoveTime = performance.now();
let smoothX = 0, smoothY = 0;
let scrollRemainder = 0, lastScrollTime = 0;
let tickCount = 0, tickTime;

// Burst Paste State
let cmdVState = null; // { time, timeout }
const DOUBLE_TAP_DELAY = 500;
const BURST_DELAY = 75; // HID stability

// Constants for behavior
const TRACKPAD = { smoothing: 0.65, deadzone: 0.15, curveMid: 0.08, curveSharpness: 10 };
const SCROLL = { scale: 0.02, minStep: 0.05, maxSteps: 6 };

// Acceleration helper
const accelCurve = (speed) =>
    1 + 1 / (1 + Math.exp(-TRACKPAD.curveSharpness * (speed - TRACKPAD.curveMid)));

const scrollCurve = (delta) => {
    const abs = Math.abs(delta);
    return abs < 10 ? abs * scrollBoost : abs;
};

// --- BURST PASTE ---
async function burstClipboard() {
    try {
        const rawText = await navigator.clipboard.readText();
        if (!rawText) return;

        const text = rawText.replace(/\r\n|\r/g, '\n');
        const statusEl = document.getElementById("status");
        const originalStatus = statusEl ? statusEl.innerText : "Connected";

        // Mapping table for characters requiring SHIFT to be pressed
        const specialChars = {
            '!': [49, 1], '@': [50, 1], '#': [51, 1], '$': [52, 1], '%': [53, 1],
            '^': [54, 1], '&': [55, 1], '*': [56, 1], '(': [57, 1], ')': [48, 1],
            '_': [45, 1], '+': [61, 1], '{': [91, 1], '}': [93, 1], '|': [92, 1],
            ':': [59, 1], '"': [39, 1], '<': [44, 1], '>': [46, 1], '?': [47, 1],
            '~': [96, 1]
        };

        for (let i = 0; i < text.length; i++) {
            let char = text[i];
            let modifier = 0;
            let keyCode = char.charCodeAt(0);

            if (specialChars[char]) {
                [keyCode, modifier] = specialChars[char];
            } else if (char >= 'A' && char <= 'Z') {
                keyCode = char.toLowerCase().charCodeAt(0);
                modifier = 1; // Shift
            }

            if (statusEl)
                statusEl.innerText = `🚀 Sending: ${i + 1}/${text.length}`;

            if (char === '\n') {
                // Enter
                sendEncrypted(keyChar, new Uint8Array([107, 13, 0, 0]));
                await new Promise(r => setTimeout(r, 40));
                sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 0]));
                await new Promise(r => setTimeout(r, 20));
            } else {
                sendEncrypted(keyChar, new Uint8Array([107, keyCode, modifier, 0]));
            }

            await new Promise(r => setTimeout(r, BURST_DELAY));
        }

        if (statusEl) {
            statusEl.innerText = "Paste Complete!";
            setTimeout(() => {
                statusEl.innerText = originalStatus;
            }, 2000);
        }
    } catch (err) {
        console.error("Clipboard error:", err);
        const statusEl = document.getElementById("status");
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

// --- MOUSE BUTTONS ---
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
    if (document.pointerLockElement !== document.getElementById("trackpad-card"))
        return;

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

// --- KEYBOARD ---
document.addEventListener("keydown", (e) => {
    const card = document.getElementById("trackpad-card");
    if (document.pointerLockElement !== card || !keyChar) return;

    // --- CMD + V DOUBLE TAP (MAC) ---
    if (e.metaKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        const now = performance.now();

        if (cmdVState && (now - cmdVState.time < DOUBLE_TAP_DELAY)) {
            clearTimeout(cmdVState.timeout);
            cmdVState = null;
            burstClipboard(); // Run burst function for Mac
            return;
        }

        // Single tap sends normal Cmd+V
        const timeout = setTimeout(() => {
            // Send Cmd+V
            sendEncrypted(keyChar, new Uint8Array([107, 118, 8, 0])); 
            cmdVState = null;
        }, DOUBLE_TAP_DELAY);

        cmdVState = { time: now, timeout };
        return;
    }

    // Modifiers
    let mod = 0;
    if (e.shiftKey) mod |= 1;
    if (e.ctrlKey) mod |= 2;
    if (e.altKey) mod |= 4;
    if (e.metaKey) mod |= 8;

    // --- OS INTERRUPT REMAPS (MAC) ---
    if (e.metaKey && e.key === "`") {
        e.preventDefault();
        sendEncrypted(keyChar, new Uint8Array([107, 96, 8, 0]));
        return;
    }

    if (e.metaKey && e.key === "Tab") {
        e.preventDefault();
        sendEncrypted(keyChar, new Uint8Array([107, 9, 8, 0]));
        return;
    }

    // --- ESCAPE LOGIC (3x ` -> ESC) ---
    if (e.key === "`") {
        e.preventDefault();
        tickCount++;
        clearTimeout(tickTime);

        if (tickCount === 3) {
            sendEncrypted(keyChar, new Uint8Array([107, 27, 0, 0]));
            tickCount = 0;
        } else {
            tickTime = setTimeout(() => {
                if (tickCount === 1)
                    sendEncrypted(keyChar, new Uint8Array([107, 96, mod, 0]));
                tickCount = 0;
            }, 500);
        }
        return;
    }

    e.preventDefault();

    // Shortcuts (Ctrl/Cmd)
    if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
        const mode = e.metaKey ? 8 : 2;
        const charCode = e.key.toLowerCase().charCodeAt(0);
        sendEncrypted(keyChar, new Uint8Array([107, charCode, mode, 0]));
        return;
    }

    // Navigation
    const nav = {
        Backspace: 8, Tab: 9, Enter: 13, Escape: 27,
        ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
        Insert: 45, Delete: 46,
        Home: 36, End: 35, PageUp: 33, PageDown: 34,
        F1: 112, F2: 113, F3: 114, F4: 115, F5: 116,
        F6: 117, F7: 118, F8: 119, F9: 120,
        F10: 121, F11: 122, F12: 123
    };

    if (nav[e.key]) {
        sendEncrypted(keyChar, new Uint8Array([107, nav[e.key], mod, 0]));
        return;
    }

    // Plain typing
    if (e.key.length === 1)
        sendEncrypted(keyChar, new Uint8Array([107, e.key.charCodeAt(0), mod, 0]));
});

// --- SCROLL DECAY ---
function decayScrollRemainder() {
    const now = performance.now();
    if (now - lastScrollTime > 40 && scrollRemainder !== 0) {
        const dt = now - lastScrollTime;
        scrollRemainder *= Math.pow(scrollDecay, dt / 16);
        if (Math.abs(scrollRemainder) < 0.01)
            scrollRemainder = 0;
    }
    requestAnimationFrame(decayScrollRemainder);
}

decayScrollRemainder();
