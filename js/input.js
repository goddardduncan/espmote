let mouseSensitivity = parseFloat(localStorage.getItem("mouseSensitivity")) || 2.0;
let scrollDecay = parseFloat(localStorage.getItem("scrollDecay")) || 0.95;
let scrollBoost = parseFloat(localStorage.getItem("scrollBoost")) || 1.4;

let lastMoveTime = performance.now();
let smoothX = 0, smoothY = 0, scrollRemainder = 0, lastScrollTime = 0;
let tickCount = 0, tickTime;

const TRACKPAD = { smoothing: 0.65, deadzone: 0.15, curveMid: 0.08, curveSharpness: 10 };
const SCROLL = { scale: 0.02, minStep: 0.05, maxSteps: 6 };

const accelCurve = (speed) => 1 + 1 / (1 + Math.exp(-TRACKPAD.curveSharpness * (speed - TRACKPAD.curveMid)));
const scrollCurve = (delta) => Math.abs(delta) < 10 ? Math.abs(delta) * scrollBoost : Math.abs(delta);

// --- Mouse Input ---
document.addEventListener("mousemove", (e) => {
    const card = document.getElementById("trackpad-card");
    if (document.pointerLockElement !== card) return;

    const now = performance.now();
    const dt = Math.max(now - lastMoveTime, 1);
    lastMoveTime = now;

    const speed = Math.sqrt(e.movementX**2 + e.movementY**2) / dt;
    smoothX = smoothX * TRACKPAD.smoothing + e.movementX * (1 - TRACKPAD.smoothing);
    smoothY = smoothY * TRACKPAD.smoothing + e.movementY * (1 - TRACKPAD.smoothing);

    if (Math.abs(smoothX) < TRACKPAD.deadzone) smoothX = 0;
    if (Math.abs(smoothY) < TRACKPAD.deadzone) smoothY = 0;

    const accel = accelCurve(speed);
    let outX = Math.max(-127, Math.min(127, Math.round(smoothX * accel * mouseSensitivity)));
    let outY = Math.max(-127, Math.min(127, Math.round(smoothY * accel * mouseSensitivity)));

    if (outX || outY) sendEncrypted(mouseChar, new Int8Array([109, outX, outY]));
});

document.addEventListener("mousedown", (e) => {
    if (document.pointerLockElement === document.getElementById("trackpad-card"))
        sendEncrypted(mouseChar, new Uint8Array([99, [1, 4, 2][e.button], 1]));
});

document.addEventListener("mouseup", (e) => {
    if (document.pointerLockElement === document.getElementById("trackpad-card"))
        sendEncrypted(mouseChar, new Uint8Array([99, [1, 4, 2][e.button], 0]));
});

document.addEventListener("wheel", (e) => {
    if (document.pointerLockElement !== document.getElementById("trackpad-card")) return;
    e.preventDefault();
    lastScrollTime = performance.now();
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    if (e.deltaMode === 2) delta *= 100;

    scrollRemainder += scrollCurve(delta) * SCROLL.scale;
    let steps = Math.min(Math.floor(Math.abs(scrollRemainder)), SCROLL.maxSteps);

    if (steps > 0) {
        const direction = delta > 0 ? -1 : 1;
        scrollRemainder -= steps * Math.sign(scrollRemainder);
        for (let i = 0; i < steps; i++) sendEncrypted(mouseChar, new Int8Array([115, direction]));
    }
}, { passive: false });

// --- Keyboard Input ---
document.addEventListener("keydown", (e) => {
    if (document.pointerLockElement !== document.getElementById("trackpad-card") || !keyChar) return;

    let mod = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);

    if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        return sendEncrypted(keyChar, new Uint8Array([107, 128, 4, 96]));
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
                if (tickCount === 1) sendEncrypted(keyChar, new Uint8Array([107, 96, 0, mod]));
                tickCount = 0;
            }, 500);
        }
        return;
    }

    e.preventDefault();

    if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
        const mode = e.metaKey ? 4 : 3;
        return sendEncrypted(keyChar, new Uint8Array([107, 128, mode, e.key.toLowerCase().charCodeAt(0)]));
    }

    const nav = { Backspace: 8, Tab: 9, Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Home: 36, End: 35 };
    if (nav[e.key]) return sendEncrypted(keyChar, new Uint8Array([107, nav[e.key], 1, mod]));

    if (e.key.length === 1) sendEncrypted(keyChar, new Uint8Array([107, e.key.charCodeAt(0), 0, mod]));
});

function decayScrollRemainder() {
    const now = performance.now();
    if (now - lastScrollTime > 40 && scrollRemainder !== 0) {
        scrollRemainder *= Math.pow(scrollDecay, (now - lastScrollTime) / 16);
        if (Math.abs(scrollRemainder) < 0.01) scrollRemainder = 0;
    }
    requestAnimationFrame(decayScrollRemainder);
}
decayScrollRemainder();