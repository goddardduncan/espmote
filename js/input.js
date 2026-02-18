// Local variables for mouse and scroll state
let mouseSensitivity = parseFloat(localStorage.getItem("mouseSensitivity")) || 2.0;
let scrollDecay = parseFloat(localStorage.getItem("scrollDecay")) || 0.95;
let scrollBoost = parseFloat(localStorage.getItem("scrollBoost")) || 1.4;

let lastMoveTime = performance.now();
let smoothX = 0, smoothY = 0;
let scrollRemainder = 0, lastScrollTime = 0;
let tickCount = 0, tickTime;

// Burst Paste State
let ctrlVState = null; // { time, timeout }
const DOUBLE_TAP_DELAY = 500;
const BURST_DELAY = 75; // HID stability

// Constants for behavior
const TRACKPAD = { smoothing: 0.65, deadzone: 0.15, curveMid: 0.08, curveSharpness: 10 };
const SCROLL = { scale: 0.02, minStep: 0.05, maxSteps: 6 };

// Shift-required symbol map (US layout)
const SHIFT_REQUIRED = {
    "!": "1",
    "@": "2",
    "#": "3",
    "$": "4",
    "%": "5",
    "^": "6",
    "&": "7",
    "*": "8",
    "(": "9",
    ")": "0",
    "_": "-",
    "+": "=",
    "{": "[",
    "}": "]",
    "|": "\\",
    ":": ";",
    "\"": "'",
    "<": ",",
    ">": ".",
    "?": "/"
};

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

        for (let i = 0; i < text.length; i++) {
            let char = text[i];

            if (statusEl)
                statusEl.innerText = `🚀 Sending: ${i + 1}/${text.length}`;

            // Handle newline
            if (char === "\n") {
                sendEncrypted(keyChar, new Uint8Array([107, 13, 1, 1]));
                await new Promise(r => setTimeout(r, 40));

                sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 0]));
                await new Promise(r => setTimeout(r, 20));
                await new Promise(r => setTimeout(r, BURST_DELAY));
                continue;
            }

            let mod = 0;
            let baseChar = char;

            // Uppercase letters
            if (char >= 'A' && char <= 'Z') {
                mod |= 1; // Shift
                baseChar = char.toLowerCase();
            }
            // Shift-required symbols
            else if (SHIFT_REQUIRED[char]) {
                mod |= 1; // Shift
                baseChar = SHIFT_REQUIRED[char];
            }

            const charCode = baseChar.charCodeAt(0);

            sendEncrypted(
                keyChar,
                new Uint8Array([107, charCode, 0, mod])
            );

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

    // --- CTRL + V DOUBLE TAP ---
    if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        const now = performance.now();

        if (ctrlVState && (now - ctrlVState.time < DOUBLE_TAP_DELAY)) {
            clearTimeout(ctrlVState.timeout);
            ctrlVState = null;
            burstClipboard();
            return;
        }

        const timeout = setTimeout(() => {
            sendEncrypted(keyChar, new Uint8Array([107, 128, 3, 118]));
            ctrlVState = null;
        }, DOUBLE_TAP_DELAY);

        ctrlVState = { time: now, timeout };
        return;
    }

    let mod = 0;
    if (e.shiftKey) mod |= 1;
    if (e.ctrlKey) mod |= 2;
    if (e.altKey) mod |= 4;
    if (e.metaKey) mod |= 8;

    e.preventDefault();

    if (e.key.length === 1)
        sendEncrypted(keyChar, new Uint8Array([107, e.key.charCodeAt(0), 0, mod]));
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
