// Local variables for mouse and scroll state
let mouseSensitivity = parseFloat(localStorage.getItem("mouseSensitivity")) || 2.0;
let scrollDecay = parseFloat(localStorage.getItem("scrollDecay")) || 0.95;
let scrollBoost = parseFloat(localStorage.getItem("scrollBoost")) || 1.4;

let lastMoveTime = performance.now();
let smoothX = 0, smoothY = 0;
let scrollRemainder = 0, lastScrollTime = 0;
let tickCount = 0, tickTime;

// Paste State
let lastPasteTime = 0;
let pendingPasteTimeout = null;

// --- OPTIMIZED DELAYS FOR RELIABILITY ---
// Time in ms to wait for a second paste key press for burst paste
const PASTE_DETECTION_DELAY = 150; 
// Time in ms between typed characters during burst paste
const BURST_TYPE_DELAY = 120; 

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

// --- BURST PASTE (Ctrl+V+V or Cmd+V+V) ---
async function burstClipboard(isMeta) {
    try {
        const rawText = await navigator.clipboard.readText();
        if (!rawText) return;

        const text = rawText.replace(/\r\n|\r/g, '\n');
        const statusEl = document.getElementById("status");
        
        // 1. Explicitly release all keys to ensure clean slate
        sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 0])); 
        await new Promise(r => setTimeout(r, 100)); // Delay to allow device to process release

        // 2. Perform the initial Paste to initiate in the target app
        // [107, key, modifier, special] -> 118='v', 2=Ctrl, 8=Meta
        const modifier = isMeta ? 8 : 2;
        sendEncrypted(keyChar, new Uint8Array([107, 118, modifier, 0])); 
        await new Promise(r => setTimeout(r, 50));
        
        // 3. Release Paste Key
        sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 0]));
        await new Promise(r => setTimeout(r, 100)); // Crucial delay for OS to react

        // 4. Type the text
        for (let i = 0; i < text.length; i++) {
            let charCode = text.charCodeAt(i);
            
            if (statusEl) statusEl.innerText = `🚀 Sending: ${i + 1}/${text.length}`;

            if (text[i] === '\n') {
                // Return / Newline
                sendEncrypted(keyChar, new Uint8Array([107, 13, 1, 1])); 
                await new Promise(r => setTimeout(r, 50)); // Delay for Newline
                
                // Explicit Release
                sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 0]));
                await new Promise(r => setTimeout(r, 30));
            } else {
                // Normal Typing
                sendEncrypted(keyChar, new Uint8Array([107, charCode, 0, 0]));
            }
            
            await new Promise(r => setTimeout(r, BURST_TYPE_DELAY));
        }

        if (statusEl) {
            statusEl.innerText = "Paste Complete!";
            setTimeout(() => { statusEl.innerText = "Connected"; }, 2000);
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

    if (outX || outY) {
        sendEncrypted(mouseChar, new Int8Array([109, outX, outY]));
    }
});

// --- MOUSE CLICKS & DRAGGING ---
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

    for (let i = 0; i < steps; i++) {
        sendEncrypted(mouseChar, new Int8Array([115, direction]));
    }
}, { passive: false });

// --- KEYBOARD LOGIC ---
document.addEventListener("keydown", (e) => {
    const card = document.getElementById("trackpad-card");
    if (document.pointerLockElement !== card || !keyChar) return;

    // --- 1. SMART PASTE DETECTION (Ctrl+V or Cmd+V) ---
    const isPaste = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v';
    
    if (isPaste) {
        const now = performance.now();
        const isMeta = e.metaKey;
        
        // Immediate prevent default to stop browser paste
        e.preventDefault();
        e.stopPropagation();

        // If second Paste pressed within window -> Burst
        if (now - lastPasteTime < PASTE_DETECTION_DELAY) {
            clearTimeout(pendingPasteTimeout);
            lastPasteTime = 0; 
            burstClipboard(isMeta);
        } else {
            // First Paste pressed -> Setup detection for second Paste
            lastPasteTime = now;
            
            pendingPasteTimeout = setTimeout(() => {
                // No second Paste pressed -> Send single Paste to client
                
                // A. Press Modifier (2=Ctrl, 8=Meta)
                const modifier = isMeta ? 8 : 2;
                sendEncrypted(keyChar, new Uint8Array([107, 0, modifier, 0])); 
                
                // B. Press V while holding Modifier
                sendEncrypted(keyChar, new Uint8Array([107, 118, modifier, 0])); 
                
                // C. Release both shortly after
                setTimeout(() => {
                    sendEncrypted(keyChar, new Uint8Array([107, 0, 0, 0]));
                }, 40);
                
                lastPasteTime = 0;
            }, PASTE_DETECTION_DELAY);
        }
        return;
    }

    // --- 2. Modifiers bitmask ---
    let mod = 0;
    if (e.shiftKey) mod |= 1;
    if (e.ctrlKey) mod |= 2;
    if (e.altKey) mod |= 4;
    if (e.metaKey) mod |= 8;

    // --- 3. OS-LEVEL INTERRUPT REMAPS ---
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

    // --- 4. ESCAPE LOGIC (3x ` -> ESC) ---
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

    // --- 5. SHORTCUTS (Ctrl/Cmd + Key) ---
    if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
        const mode = e.metaKey ? 4 : 3; // 3=Ctrl, 4=Meta
        const charCode = e.key.toLowerCase().charCodeAt(0);
        sendEncrypted(keyChar, new Uint8Array([107, 128, mode, charCode]));
        return;
    }

    // --- 6. NAVIGATION & FUNCTION KEYS (Mode 1) ---
    const nav = {
        Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ArrowLeft: 37, ArrowUp: 38,
        ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
        Home: 36, End: 35, PageUp: 33, PageDown: 34,
        F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
        F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123
    };

    if (nav[e.key]) {
        sendEncrypted(keyChar, new Uint8Array([107, nav[e.key], 1, mod]));
        return;
    }

    // --- 7. PLAIN TYPING ---
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
