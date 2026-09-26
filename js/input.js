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
const BURST_DELAY = 30; // HID stability (firmware queues packets, so this can be short)

// Constants for behavior
const TRACKPAD = { smoothing: 0.65, deadzone: 0.15, curveMid: 0.08, curveSharpness: 10 };
const SCROLL = { scale: 0.02, minStep: 0.05, maxSteps: 6 };

// Shift-required symbol map (US layout)
const SHIFT_REQUIRED = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
    "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "-", "+": "=", "{": "[", "}": "]",
    "|": "\\", ":": ";", "\"": "'", "<": ",",
    ">": ".", "?": "/"
};

// Physical key (KeyboardEvent.code) -> USB HID usage ID
const HID_USAGE = (() => {
    const map = {
        Enter: 0x28, Escape: 0x29, Backspace: 0x2A, Tab: 0x2B, Space: 0x2C,
        Minus: 0x2D, Equal: 0x2E, BracketLeft: 0x2F, BracketRight: 0x30, Backslash: 0x31,
        Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
        CapsLock: 0x39, PrintScreen: 0x46, ScrollLock: 0x47, Pause: 0x48,
        Insert: 0x49, Home: 0x4A, PageUp: 0x4B, Delete: 0x4C, End: 0x4D, PageDown: 0x4E,
        ArrowRight: 0x4F, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
        NumLock: 0x53, NumpadDivide: 0x54, NumpadMultiply: 0x55, NumpadSubtract: 0x56,
        NumpadAdd: 0x57, NumpadEnter: 0x58, NumpadDecimal: 0x63, IntlBackslash: 0x64,
        ContextMenu: 0x65, NumpadEqual: 0x67,
        ControlLeft: 0xE0, ShiftLeft: 0xE1, AltLeft: 0xE2, MetaLeft: 0xE3,
        ControlRight: 0xE4, ShiftRight: 0xE5, AltRight: 0xE6, MetaRight: 0xE7,
    };
    for (let i = 0; i < 26; i++) map["Key" + String.fromCharCode(65 + i)] = 0x04 + i;
    for (let i = 1; i <= 9; i++) map["Digit" + i] = 0x1E + i - 1;
    map.Digit0 = 0x27;
    for (let i = 1; i <= 9; i++) map["Numpad" + i] = 0x59 + i - 1;
    map.Numpad0 = 0x62;
    for (let i = 1; i <= 12; i++) map["F" + i] = 0x3A + i - 1;
    for (let i = 13; i <= 24; i++) map["F" + i] = 0x68 + i - 13;
    return map;
})();

const isModifier = (usage) => usage >= 0xE0;

// Keyboard state mirrored on the target
const heldKeys = new Set(); // HID usages currently held down on the target
let ctrlAsCmd = false;      // Ctrl is being forwarded as Cmd (window switching)
let capsSent = false;       // CapsLock state last sent to the target

// Acceleration helper
const accelCurve = (speed) =>
    1 + 1 / (1 + Math.exp(-TRACKPAD.curveSharpness * (speed - TRACKPAD.curveMid)));

const scrollCurve = (delta) => {
    const abs = Math.abs(delta);
    return abs < 10 ? abs * scrollBoost : abs;
};



// =====================================================
// ================= BURST PASTE =======================
// =====================================================

async function burstClipboard() {
    try {
        const rawText = await navigator.clipboard.readText();
        if (!rawText) return;

        const text = rawText.replace(/\r\n|\r/g, '\n');
        const statusEl = document.getElementById("status");
        const originalStatus = statusEl ? statusEl.innerText : "Connected";

        // Drop the held Ctrl/Cmd so pasted characters aren't sent as shortcuts
        releaseAll();

        for (let i = 0; i < text.length; i++) {
            let char = text[i];

            if (statusEl)
                statusEl.innerText = `🚀 Sending: ${i + 1}/${text.length}`;

            // Handle newline
            if (char === "\n") {
                sendKey(new Uint8Array([107, 13, 1, 1]));
                await new Promise(r => setTimeout(r, 40));
                sendKey(new Uint8Array([107, 0, 0, 0]));
                await new Promise(r => setTimeout(r, 20));
                await new Promise(r => setTimeout(r, BURST_DELAY));
                continue;
            }

            let mod = 0;
            let baseChar = char;

            if (char >= 'A' && char <= 'Z') {
                mod |= 1;
                baseChar = char.toLowerCase();
            } else if (SHIFT_REQUIRED[char]) {
                mod |= 1;
                baseChar = SHIFT_REQUIRED[char];
            }

            const charCode = baseChar.charCodeAt(0);

            sendKey(new Uint8Array([107, charCode, 0, mod]));
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



// =====================================================
// ================= MOUSE MOVEMENT ====================
// =====================================================

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



// =====================================================
// ================= MOUSE BUTTONS =====================
// =====================================================

document.addEventListener("mousedown", (e) => {
    if (document.pointerLockElement === document.getElementById("trackpad-card"))
        sendEncrypted(mouseChar, new Uint8Array([99, [1, 4, 2][e.button], 1]));
});

document.addEventListener("mouseup", (e) => {
    if (document.pointerLockElement === document.getElementById("trackpad-card"))
        sendEncrypted(mouseChar, new Uint8Array([99, [1, 4, 2][e.button], 0]));
});



// =====================================================
// ================= SCROLLING =========================
// =====================================================

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



// =====================================================
// ================= KEYBOARD ==========================
// =====================================================

// Keys are forwarded as real down/up events so modifiers stay held
// (Shift-click, Ctrl-click, Alt-drag) and the target does its own auto-repeat.

const keyDown = (usage) => {
    heldKeys.add(usage);
    sendKey(new Uint8Array([100, usage]));
};

const keyUp = (usage) => {
    heldKeys.delete(usage);
    sendKey(new Uint8Array([117, usage]));
};

// Press and release a key, briefly holding any of `mods` the target doesn't already have down
function tapKey(usage, mods = []) {
    const added = mods.filter(m => !heldKeys.has(m));
    added.forEach(keyDown);
    sendKey(new Uint8Array([100, usage]));
    sendKey(new Uint8Array([117, usage]));
    added.forEach(keyUp);
}

// Release every key and mouse button on the target and forget pending key tricks
function releaseAll() {
    heldKeys.clear();
    ctrlAsCmd = false;
    tickCount = 0;
    clearTimeout(tickTime);
    if (ctrlVState) {
        clearTimeout(ctrlVState.timeout);
        ctrlVState = null;
    }
    sendKey(new Uint8Array([114]));
}

// macOS fires keydown only when CapsLock turns on and keyup only when it turns off,
// so tap it on the target whenever the controller's lock state changes
function syncCapsLock(e) {
    const on = e.getModifierState("CapsLock");
    if (on !== capsSent) {
        tapKey(HID_USAGE.CapsLock);
        capsSent = on;
    }
}

document.addEventListener("keydown", (e) => {
    const card = document.getElementById("trackpad-card");
    if (document.pointerLockElement !== card || !keyChar) return;
    e.preventDefault();

    if (e.code === "CapsLock") return syncCapsLock(e);

    const usage = HID_USAGE[e.code];
    if (!usage) return;

    // Modifiers captured now, for keys that are sent after a delay
    const heldMods = [...heldKeys].filter(isModifier);

    // ================= CTRL/CMD + V =================

    const isPasteCombo =
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.code === "KeyV";

    if (isPasteCombo) {
        if (e.repeat) return;
        const now = performance.now();

        if (ctrlVState && (now - ctrlVState.time < DOUBLE_TAP_DELAY)) {
            clearTimeout(ctrlVState.timeout);
            ctrlVState = null;
            burstClipboard();
            return;
        }

        const timeout = setTimeout(() => {
            tapKey(usage, heldMods);
            ctrlVState = null;
        }, DOUBLE_TAP_DELAY);

        ctrlVState = { time: now, timeout };
        return;
    }

    // --- OS INTERRUPT REMAPS ---
    // The controller OS grabs Cmd+` / Cmd+Tab, so Ctrl stands in for Cmd.
    // Cmd stays held on the target until Ctrl is released, keeping the switcher open.
    if (e.ctrlKey && (e.code === "Backquote" || e.code === "Tab")) {
        if (!ctrlAsCmd) {
            [HID_USAGE.ControlLeft, HID_USAGE.ControlRight].filter(u => heldKeys.has(u)).forEach(keyUp);
            keyDown(HID_USAGE.MetaLeft);
            ctrlAsCmd = true;
        }
        tapKey(usage);
        return;
    }

    // --- ESCAPE LOGIC (3x ` -> ESC) ---
    if (e.code === "Backquote") {
        if (e.repeat) return;
        tickCount++;
        clearTimeout(tickTime);

        if (tickCount === 3) {
            tapKey(HID_USAGE.Escape);
            tickCount = 0;
        } else {
            tickTime = setTimeout(() => {
                if (tickCount === 1) tapKey(usage, heldMods);
                tickCount = 0;
            }, 500);
        }
        return;
    }

    if (isModifier(usage)) {
        if (!heldKeys.has(usage)) keyDown(usage);
        return;
    }

    // macOS never fires keyup for keys released while Cmd is held, so tap instead of hold
    // (browser repeats still come through as repeated taps)
    if (e.metaKey) {
        tapKey(usage);
        return;
    }

    if (!heldKeys.has(usage)) keyDown(usage);
});

document.addEventListener("keyup", (e) => {
    const card = document.getElementById("trackpad-card");
    if (document.pointerLockElement !== card || !keyChar) return;
    e.preventDefault();

    if (e.code === "CapsLock") return syncCapsLock(e);

    if (ctrlAsCmd && (e.code === "ControlLeft" || e.code === "ControlRight")) {
        keyUp(HID_USAGE.MetaLeft);
        ctrlAsCmd = false;
        return;
    }

    // Keys released while Cmd was down never reported keyup on macOS
    if (e.code === "MetaLeft" || e.code === "MetaRight")
        [...heldKeys].filter(u => !isModifier(u)).forEach(keyUp);

    const usage = HID_USAGE[e.code];
    if (heldKeys.has(usage)) keyUp(usage);
});

// Losing pointer lock (Esc, switching app/tab) means we'll miss the releases, so drop everything
document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement !== document.getElementById("trackpad-card"))
        releaseAll();
});



// =====================================================
// ================= SCROLL DECAY ======================
// =====================================================

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
