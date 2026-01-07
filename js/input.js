// Local variables for mouse and scroll state
let mouseSensitivity = parseFloat(localStorage.getItem("mouseSensitivity")) || 2.0;
let scrollDecay = parseFloat(localStorage.getItem("scrollDecay")) || 0.95;
let scrollBoost = parseFloat(localStorage.getItem("scrollBoost")) || 1.4;

let lastMoveTime = performance.now();
let smoothX = 0, smoothY = 0;
let scrollRemainder = 0, lastScrollTime = 0;
let tickCount = 0, tickTime;

// Constants for behavior
const TRACKPAD = { smoothing: 0.65, deadzone: 0.15, curveMid: 0.08, curveSharpness: 10 };
const SCROLL = { scale: 0.02, minStep: 0.05, maxSteps: 6 };

// Acceleration helpers
const accelCurve = (speed) => 1 + 1 / (1 + Math.exp(-TRACKPAD.curveSharpness * (speed - TRACKPAD.curveMid)));
const scrollCurve = (delta) => {
    const abs = Math.abs(delta);
    return abs < 10 ? abs * scrollBoost : abs;
};

// --- MOUSE MOVEMENT ---
document.addEventListener("mousemove", (e) => {
    const card = document.getElementById("trackpad-card");
    if (document.pointerLockElement !== card) return;

    const now = performance.now();
    const dt = Math.max(now - lastMoveTime, 1);
    lastMoveTime = now;

    const rawX = e.movementX;
    const rawY = e.movementY;

    // Velocity (px/ms)
    const speed = Math.sqrt(rawX * rawX + rawY * rawY) / dt;

    // Temporal smoothing
    smoothX = smoothX * TRACKPAD.smoothing + rawX * (1 - TRACKPAD.smoothing);
    smoothY = smoothY * TRACKPAD.smoothing + rawY * (1 - TRACKPAD.smoothing);

    // Deadzone
    if (Math.abs(smoothX) < TRACKPAD.deadzone) smoothX = 0;
    if (Math.abs(smoothY) < TRACKPAD.deadzone) smoothY = 0;

    // Acceleration
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

    // Normalize wheel units
    if (e.deltaMode === 1) delta *= 16;
    if (e.deltaMode === 2) delta *= 100;

    // Apply curve + scale
    const curved = scrollCurve(delta) * SCROLL.scale;

    // Accumulate
    scrollRemainder += curved;

    // Extract whole steps
    let steps = Math.floor(Math.abs(scrollRemainder));
    if (steps === 0) return;

    // Clamp burst
    steps = Math.min(steps, SCROLL.maxSteps);

    const direction = delta > 0 ? -1 : 1;

    // Remove emitted steps
    scrollRemainder -= steps * Math.sign(scrollRemainder);

    for (let i = 0; i < steps; i++) {
        sendEncrypted(mouseChar, new Int8Array([115, direction]));
    }
}, { passive: false });

// --- KEYBOARD LOGIC ---
document.addEventListener("keydown", (e) => {
    const card = document.getElementById("trackpad-card");
    if (document.pointerLockElement !== card || !keyChar) return;

    // 1. Calculate Bitmask
    let mod = 0;
    if (e.shiftKey) mod |= 1;
    if (e.ctrlKey) mod |= 2;
    if (e.altKey) mod |= 4;
    if (e.metaKey) mod |= 8;

    // 2. BROWSER REMAPS (Special handling for OS-level interrupts)
    if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        sendEncrypted(keyChar, new Uint8Array([107, 128, 4, 96])); // Mode 4, Key 96
        return;
    }
    if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        sendEncrypted(keyChar, new Uint8Array([107, 128, 4, 9])); // Mode 4, Key 9
        return;
    }

    // 3. ESC LOGIC (3x ` -> ESC)
    if (e.key === "`") {
        e.preventDefault();
        tickCount++;
        clearTimeout(tickTime);
        if (tickCount === 3) {
            sendEncrypted(keyChar, new Uint8Array([107, 27, 1, 0])); // ESC key
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

    // 4. SHORTCUTS (Cmd+C, Cmd+V, Ctrl+C etc.)
    // Note: If metaKey (Cmd) is pressed, use Mode 4. If Ctrl is pressed, use Mode 3.
    if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
        const mode = e.metaKey ? 4 : 3;
        const charCode = e.key.toLowerCase().charCodeAt(0);
        sendEncrypted(keyChar, new Uint8Array([107, 128, mode, charCode]));
        return;
    }

    // 5. NAVIGATION & FUNCTION KEYS
    const nav = {
        Backspace: 8,
        Tab: 9,
        Enter: 13,
        ArrowLeft: 37,
        ArrowUp: 38,
        ArrowRight: 39,
        ArrowDown: 40,
        Insert: 45,
        Delete: 46,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34,
        F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
        F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123
    };

    if (nav[e.key]) {
        sendEncrypted(keyChar, new Uint8Array([107, nav[e.key], 1, mod]));
        return;
    }

    // 6. PLAIN TYPING
    if (e.key.length === 1) {
        sendEncrypted(
            keyChar,
            new Uint8Array([107, e.key.charCodeAt(0), 0, mod])
        );
    }
});

// --- SCROLL DECAY ANIMATION ---
function decayScrollRemainder() {
    const now = performance.now();

    // Only decay when idle (no recent wheel events)
    if (now - lastScrollTime > 40 && scrollRemainder !== 0) {
        const dt = now - lastScrollTime;
        // Decay based on the user-defined scrollDecay value
        scrollRemainder *= Math.pow(scrollDecay, dt / 16);

        if (Math.abs(scrollRemainder) < 0.01) {
            scrollRemainder = 0;
        }
    }
    requestAnimationFrame(decayScrollRemainder);
}

// Start the animation loop
decayScrollRemainder();