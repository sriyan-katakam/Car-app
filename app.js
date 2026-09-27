// ============================================================
//  BLE CONFIGURATION — YC_CAR_DEMO Bluetooth LE Settings
// ============================================================
const BLE_CONFIG = {
    deviceName: "YC_CAR_DEMO",
    serviceUuid: 0xfff0,
    writeCharacteristicUuid: 0xfff2,
    notifyCharacteristicUuid: 0xfff1,
    modeByte: 0x01,
    intervalMs: 80      // Fast 80ms transmission loop
};

// ============================================================
//  CONTROL MAPPING SECTION
//  Bitmask with active play-bit (Bit 6 = 1 -> 0x40 Base)
//  [0][play=1][0][0][Steer-Right][Steer-Left][Backward][Forward]
// ============================================================
const PROTOCOL_PRESETS = {
    "yc_standard": {
        name: "YC Standard (0x40 Base with Play-Bit)",
        FORWARD:       0x41,
        REVERSE:       0x42,
        LEFT:          0x44,
        RIGHT:         0x48,
        FORWARD_LEFT:  0x45,
        FORWARD_RIGHT: 0x49,
        REVERSE_LEFT:  0x46,
        REVERSE_RIGHT: 0x4A,
        STOP:          0x40
    },
    "yc_raw": {
        name: "Raw Nibble (No 0x40 Play-Bit)",
        FORWARD:       0x01,
        REVERSE:       0x02,
        LEFT:          0x04,
        RIGHT:         0x08,
        FORWARD_LEFT:  0x05,
        FORWARD_RIGHT: 0x09,
        REVERSE_LEFT:  0x06,
        REVERSE_RIGHT: 0x0A,
        STOP:          0x00
    },
    "sequential": {
        name: "Sequential Enum (0x01 - 0x04)",
        FORWARD:       0x01,
        REVERSE:       0x02,
        LEFT:          0x03,
        RIGHT:         0x04,
        FORWARD_LEFT:  0x01,
        FORWARD_RIGHT: 0x01,
        REVERSE_LEFT:  0x02,
        REVERSE_RIGHT: 0x02,
        STOP:          0x00
    }
};

let CONTROL_MAP = Object.assign({}, PROTOCOL_PRESETS.yc_standard);

// ============================================================
//  STATE
// ============================================================
let bleDevice = null;
let bleServer = null;
let writeCharacteristic = null;
let notifyCharacteristic = null;
let controlInterval = null;
let connected = false;
let isWriting = false;
let currentSpeed = 100; // 0x64 full throttle
let soundEnabled = true;
let headlightsOn = false;

// Directional states
const activeDirections = {
    forward: false,
    reverse: false,
    left: false,
    right: false
};

const heldKeys = new Set();
let currentControlByte = null;
let currentCommandLabel = "STANDBY";
let totalPacketsSent = 0;

// ============================================================
//  DOM ELEMENTS
// ============================================================
const connectBtn        = document.getElementById("connect-btn");
const deviceLabel       = document.getElementById("device-label");
const statusDot         = document.getElementById("status-dot");
const txLed             = document.getElementById("tx-led");
const rxLed             = document.getElementById("rx-led");
const steerPod          = document.getElementById("steer-pod");
const steerKnob         = document.getElementById("steer-knob");
const steerWell         = document.getElementById("steer-well");
const throttlePod       = document.getElementById("throttle-pod");
const throttleKnob      = document.getElementById("throttle-knob");
const throttleWell      = document.getElementById("throttle-well");

const chevronLeft       = document.getElementById("chevron-left");
const chevronRight      = document.getElementById("chevron-right");
const chevronUp         = document.getElementById("chevron-up");
const chevronDown       = document.getElementById("chevron-down");

const headlightBtn      = document.getElementById("headlight-btn");
const headlightBeam     = document.getElementById("headlight-beam");
const parkBtn           = document.getElementById("park-btn");
const hornBtn           = document.getElementById("horn-btn");
const soundToggleBtn    = document.getElementById("sound-toggle-btn");

const hudSpeedText      = document.getElementById("hud-speed-text");
const hudStateText      = document.getElementById("hud-state-text");
const centerSpeedBadge  = document.querySelector(".center-speed-badge");

const settingsBtn       = document.getElementById("settings-btn");
const settingsDrawer    = document.getElementById("settings-drawer");
const closeDrawerBtn    = document.getElementById("close-drawer-btn");
const presetSelector    = document.getElementById("preset-selector");
const speedSlider       = document.getElementById("speed-slider");
const drawerSpeedVal    = document.getElementById("drawer-speed-val");

const debugDeviceName   = document.getElementById("debug-device");
const debugConnStatus   = document.getElementById("debug-conn-status");
const debugLastTx       = document.getElementById("debug-last-tx");
const debugLastRx       = document.getElementById("debug-last-rx");
const debugError        = document.getElementById("debug-error");

// ============================================================
//  WEB AUDIO SYNTHESIZER
// ============================================================
let audioCtx = null;

function getAudioContext() {
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
    }
    return audioCtx;
}

function playSound(type) {
    if (!soundEnabled) return;
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        const now = ctx.currentTime;

        if (type === "horn") {
            // Authentic dual-tone car horn (F#4 370Hz + A#4 466Hz)
            [370, 466].forEach(freq => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = "sawtooth";
                osc.frequency.setValueAtTime(freq, now);
                gain.gain.setValueAtTime(0.12, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(now);
                osc.stop(now + 0.35);
            });
            return;
        }

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

        if (type === "connect") {
            osc.type = "sine";
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
            osc.frequency.exponentialRampToValueAtTime(1320, now + 0.25);
            gain.gain.setValueAtTime(0.15, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
            osc.start(now);
            osc.stop(now + 0.35);
        } else if (type === "disconnect") {
            osc.type = "sawtooth";
            osc.frequency.setValueAtTime(600, now);
            osc.frequency.exponentialRampToValueAtTime(120, now + 0.3);
            gain.gain.setValueAtTime(0.12, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
            osc.start(now);
            osc.stop(now + 0.35);
        } else if (type === "drive") {
            osc.type = "triangle";
            const freq = 120 + (currentSpeed * 2.2);
            osc.frequency.setValueAtTime(freq, now);
            osc.frequency.exponentialRampToValueAtTime(freq * 1.3, now + 0.14);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
            osc.start(now);
            osc.stop(now + 0.16);
        } else if (type === "steer") {
            osc.type = "sine";
            osc.frequency.setValueAtTime(750, now);
            osc.frequency.exponentialRampToValueAtTime(980, now + 0.08);
            gain.gain.setValueAtTime(0.06, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
            osc.start(now);
            osc.stop(now + 0.1);
        } else if (type === "stop") {
            osc.type = "square";
            osc.frequency.setValueAtTime(180, now);
            osc.frequency.exponentialRampToValueAtTime(50, now + 0.12);
            gain.gain.setValueAtTime(0.08, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
            osc.start(now);
            osc.stop(now + 0.14);
        } else if (type === "click") {
            osc.type = "sine";
            osc.frequency.setValueAtTime(1200, now);
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
            osc.start(now);
            osc.stop(now + 0.05);
        }
    } catch (e) {}
}

function triggerHaptic(duration = 20) {
    if (navigator.vibrate) {
        try { navigator.vibrate(duration); } catch (e) {}
    }
}

// ============================================================
//  PACKET BUILDER
// ============================================================
function buildPacket(controlByte, speed) {
    return new Uint8Array([
        0xAA,
        0x00,
        0x02,
        0x00,
        0x00,
        0x00,
        0x00,
        controlByte & 0xFF,
        speed & 0xFF,
        BLE_CONFIG.modeByte & 0xFF
    ]);
}

// ============================================================
//  SEND COMMAND VIA BLE
// ============================================================
async function sendCommand(controlByte, speed) {
    if (!connected || !writeCharacteristic) return;

    if (isWriting) return;
    isWriting = true;

    const packet = buildPacket(controlByte, speed);
    const hex = Array.from(packet).map(b => b.toString(16).toUpperCase().padStart(2, "0")).join(" ");

    try {
        if (writeCharacteristic.properties && writeCharacteristic.properties.writeWithoutResponse) {
            await writeCharacteristic.writeValueWithoutResponse(packet);
        } else if (writeCharacteristic.writeValueWithoutResponse) {
            await writeCharacteristic.writeValueWithoutResponse(packet);
        } else {
            await writeCharacteristic.writeValueWithResponse(packet);
        }

        totalPacketsSent++;
        if (debugLastTx) debugLastTx.textContent = "TX: " + hex;

        if (txLed) {
            txLed.classList.add("active");
            setTimeout(() => txLed.classList.remove("active"), 50);
        }
    } catch (err) {
        logDebugError("Write failed: " + err.message);
        stopAll(true);
    } finally {
        isWriting = false;
    }
}

// ============================================================
//  DIRECTION RESOLVER & REPEAT LOOP
// ============================================================
function computeCurrentControl() {
    const fwd = activeDirections.forward;
    const rev = activeDirections.reverse;
    const lft = activeDirections.left;
    const rgt = activeDirections.right;

    const movingFwd = fwd && !rev;
    const movingRev = rev && !fwd;
    const turningLft = lft && !rgt;
    const turningRgt = rgt && !lft;

    if (movingFwd && turningLft) return { byte: CONTROL_MAP.FORWARD_LEFT, label: "FWD+LEFT", sound: "drive" };
    if (movingFwd && turningRgt) return { byte: CONTROL_MAP.FORWARD_RIGHT, label: "FWD+RIGHT", sound: "drive" };
    if (movingRev && turningLft) return { byte: CONTROL_MAP.REVERSE_LEFT, label: "REV+LEFT", sound: "drive" };
    if (movingRev && turningRgt) return { byte: CONTROL_MAP.REVERSE_RIGHT, label: "REV+RIGHT", sound: "drive" };

    if (movingFwd)   return { byte: CONTROL_MAP.FORWARD, label: "DRIVE", sound: "drive" };
    if (movingRev)   return { byte: CONTROL_MAP.REVERSE, label: "REVERSE", sound: "drive" };
    if (turningLft)  return { byte: CONTROL_MAP.LEFT, label: "LEFT", sound: "steer" };
    if (turningRgt)  return { byte: CONTROL_MAP.RIGHT, label: "RIGHT", sound: "steer" };

    return { byte: CONTROL_MAP.STOP, label: "STANDBY", sound: "stop" };
}

function updateDriveState() {
    const { byte, label, sound } = computeCurrentControl();

    // Update Chevron indicators
    if (chevronLeft) chevronLeft.classList.toggle("active", activeDirections.left);
    if (chevronRight) chevronRight.classList.toggle("active", activeDirections.right);
    if (chevronUp) chevronUp.classList.toggle("active", activeDirections.forward);
    if (chevronDown) chevronDown.classList.toggle("active", activeDirections.reverse);

    if (label === "STANDBY") {
        stopIntervalOnly();
        if (connected) {
            sendCommand(CONTROL_MAP.STOP, 0x00);
        }
        currentControlByte = CONTROL_MAP.STOP;
        currentCommandLabel = "STANDBY";
        updateBadgeUI("STANDBY", false);
        return;
    }

    const commandChanged = (currentCommandLabel !== label);
    currentControlByte = byte;
    currentCommandLabel = label;

    if (commandChanged) {
        playSound(sound);
        triggerHaptic(20);
    }

    updateBadgeUI(label, true);

    if (!controlInterval) {
        const sendCurrent = () => {
            sendCommand(currentControlByte, currentSpeed);
        };

        sendCurrent();
        controlInterval = setInterval(sendCurrent, BLE_CONFIG.intervalMs);
    }
}

function updateBadgeUI(stateText, isDriving) {
    if (hudStateText) hudStateText.textContent = stateText;
    if (centerSpeedBadge) {
        centerSpeedBadge.classList.toggle("driving", isDriving);
    }
}

function stopIntervalOnly() {
    if (controlInterval) {
        clearInterval(controlInterval);
        controlInterval = null;
    }
}

function stopAll(sendStopPacket = true) {
    activeDirections.forward = false;
    activeDirections.reverse = false;
    activeDirections.left = false;
    activeDirections.right = false;
    heldKeys.clear();

    setJoystickKnobPos(steerKnob, 0, 0);
    setJoystickKnobPos(throttleKnob, 0, 0);
    steerPod.classList.remove("active");
    throttlePod.classList.remove("active");

    if (chevronLeft) chevronLeft.classList.remove("active");
    if (chevronRight) chevronRight.classList.remove("active");
    if (chevronUp) chevronUp.classList.remove("active");
    if (chevronDown) chevronDown.classList.remove("active");

    stopIntervalOnly();
    currentCommandLabel = "STANDBY";
    currentControlByte = CONTROL_MAP.STOP;

    if (sendStopPacket && connected && writeCharacteristic) {
        sendCommand(CONTROL_MAP.STOP, 0x00);
        playSound("stop");
    }

    updateBadgeUI("STANDBY", false);
}

// ============================================================
//  TOUCH & POINTER DUAL-JOYSTICK ENGINE
// ============================================================
function setJoystickKnobPos(knob, x, y) {
    if (knob) {
        knob.style.transform = `translate(${x}px, ${y}px)`;
    }
}

function setupJoystick(pod, knob, axisType) {
    let isTracking = false;
    let pointerId = null;
    const maxRadius = 50;

    function handlePointerDown(e) {
        e.preventDefault();
        isTracking = true;
        pointerId = e.pointerId;
        pod.setPointerCapture(pointerId);
        pod.classList.add("active");
        processPointer(e);
    }

    function handlePointerMove(e) {
        if (!isTracking || e.pointerId !== pointerId) return;
        processPointer(e);
    }

    function handlePointerUp(e) {
        if (!isTracking || e.pointerId !== pointerId) return;
        isTracking = false;
        try { pod.releasePointerCapture(pointerId); } catch (err) {}
        pod.classList.remove("active");

        setJoystickKnobPos(knob, 0, 0);

        if (axisType === "steer") {
            activeDirections.left = false;
            activeDirections.right = false;
        } else if (axisType === "throttle") {
            activeDirections.forward = false;
            activeDirections.reverse = false;
        }

        updateDriveState();
    }

    function processPointer(e) {
        const rect = pod.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let deltaX = e.clientX - centerX;
        let deltaY = e.clientY - centerY;

        if (axisType === "steer") {
            deltaY = deltaY * 0.22;
            const dist = Math.hypot(deltaX, deltaY);
            if (dist > maxRadius) {
                const angle = Math.atan2(deltaY, deltaX);
                deltaX = Math.cos(angle) * maxRadius;
                deltaY = Math.sin(angle) * maxRadius;
            }

            setJoystickKnobPos(knob, deltaX, deltaY);

            if (deltaX < -15) {
                activeDirections.left = true;
                activeDirections.right = false;
            } else if (deltaX > 15) {
                activeDirections.right = true;
                activeDirections.left = false;
            } else {
                activeDirections.left = false;
                activeDirections.right = false;
            }
        } else if (axisType === "throttle") {
            deltaX = deltaX * 0.22;
            const dist = Math.hypot(deltaX, deltaY);
            if (dist > maxRadius) {
                const angle = Math.atan2(deltaY, deltaX);
                deltaX = Math.cos(angle) * maxRadius;
                deltaY = Math.sin(angle) * maxRadius;
            }

            setJoystickKnobPos(knob, deltaX, deltaY);

            // Drag Up is negative Y, Drag Down is positive Y
            if (deltaY < -15) {
                activeDirections.forward = true;
                activeDirections.reverse = false;
            } else if (deltaY > 15) {
                activeDirections.reverse = true;
                activeDirections.forward = false;
            } else {
                activeDirections.forward = false;
                activeDirections.reverse = false;
            }
        }

        updateDriveState();
    }

    pod.addEventListener("pointerdown", handlePointerDown);
    pod.addEventListener("pointermove", handlePointerMove);
    pod.addEventListener("pointerup", handlePointerUp);
    pod.addEventListener("pointercancel", handlePointerUp);
}

// ============================================================
//  KEYBOARD CONTROLS (WASD, Arrows, Space)
// ============================================================
document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type === "text") return;

    const key = e.key.toLowerCase();
    if (heldKeys.has(key)) return;
    heldKeys.add(key);

    if (key === " " || key === "spacebar") {
        e.preventDefault();
        stopAll(true);
        return;
    }

    let changed = false;

    if (key === "w" || key === "arrowup") {
        activeDirections.forward = true;
        setJoystickKnobPos(throttleKnob, 0, -45);
        throttlePod.classList.add("active");
        changed = true;
    }
    if (key === "s" || key === "arrowdown") {
        activeDirections.reverse = true;
        setJoystickKnobPos(throttleKnob, 0, 45);
        throttlePod.classList.add("active");
        changed = true;
    }
    if (key === "a" || key === "arrowleft") {
        activeDirections.left = true;
        setJoystickKnobPos(steerKnob, -45, 0);
        steerPod.classList.add("active");
        changed = true;
    }
    if (key === "d" || key === "arrowright") {
        activeDirections.right = true;
        setJoystickKnobPos(steerKnob, 45, 0);
        steerPod.classList.add("active");
        changed = true;
    }

    if (changed) {
        e.preventDefault();
        updateDriveState();
    }
});

document.addEventListener("keyup", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type === "text") return;

    const key = e.key.toLowerCase();
    heldKeys.delete(key);

    if (key === "w" || key === "arrowup") {
        activeDirections.forward = false;
        if (!activeDirections.reverse) {
            setJoystickKnobPos(throttleKnob, 0, 0);
            throttlePod.classList.remove("active");
        }
    }
    if (key === "s" || key === "arrowdown") {
        activeDirections.reverse = false;
        if (!activeDirections.forward) {
            setJoystickKnobPos(throttleKnob, 0, 0);
            throttlePod.classList.remove("active");
        }
    }
    if (key === "a" || key === "arrowleft") {
        activeDirections.left = false;
        if (!activeDirections.right) {
            setJoystickKnobPos(steerKnob, 0, 0);
            steerPod.classList.remove("active");
        }
    }
    if (key === "d" || key === "arrowright") {
        activeDirections.right = false;
        if (!activeDirections.left) {
            setJoystickKnobPos(steerKnob, 0, 0);
            steerPod.classList.remove("active");
        }
    }

    updateDriveState();
});

// ============================================================
//  FLOATING ACTION BUTTONS
// ============================================================
if (headlightBtn) {
    headlightBtn.addEventListener("click", () => {
        headlightsOn = !headlightsOn;
        headlightBtn.classList.toggle("active", headlightsOn);
        if (headlightBeam) headlightBeam.classList.toggle("active", headlightsOn);
        playSound("click");
        triggerHaptic(25);
    });
}

if (parkBtn) {
    parkBtn.addEventListener("click", () => {
        stopAll(true);
        parkBtn.classList.add("active");
        setTimeout(() => parkBtn.classList.remove("active"), 350);
        playSound("stop");
        triggerHaptic(40);
    });
}

if (hornBtn) {
    hornBtn.addEventListener("click", () => {
        playSound("horn");
        triggerHaptic(50);
    });
}

if (soundToggleBtn) {
    soundToggleBtn.addEventListener("click", () => {
        soundEnabled = !soundEnabled;
        soundToggleBtn.textContent = soundEnabled ? "🔊" : "🔇";
        soundToggleBtn.classList.toggle("muted", !soundEnabled);
        if (soundEnabled) playSound("connect");
    });
}

// ============================================================
//  SPEED & SETTINGS DRAWER
// ============================================================
function updateSpeed(val) {
    currentSpeed = parseInt(val, 10);
    if (speedSlider) speedSlider.value = currentSpeed;
    if (drawerSpeedVal) drawerSpeedVal.textContent = currentSpeed + "%";
    if (hudSpeedText) hudSpeedText.textContent = currentSpeed + "%";

    document.querySelectorAll(".preset-chip").forEach(chip => {
        const chipSpd = parseInt(chip.dataset.speed, 10);
        chip.classList.toggle("active", chipSpd === currentSpeed);
    });
}

if (speedSlider) {
    speedSlider.addEventListener("input", (e) => {
        updateSpeed(e.target.value);
    });
}

document.querySelectorAll(".preset-chip").forEach(chip => {
    chip.addEventListener("click", () => {
        updateSpeed(chip.dataset.speed);
        playSound("click");
        triggerHaptic(20);
    });
});

settingsBtn.addEventListener("click", () => {
    settingsDrawer.classList.add("open");
    playSound("click");
});

closeDrawerBtn.addEventListener("click", () => {
    settingsDrawer.classList.remove("open");
});

if (presetSelector) {
    presetSelector.addEventListener("change", (e) => {
        const selected = PROTOCOL_PRESETS[e.target.value];
        if (selected) {
            CONTROL_MAP = Object.assign({}, selected);
            logDebugError("Switched protocol: " + selected.name);
            playSound("steer");
        }
    });
}

window.sendCustomHexByte = function(hexStr) {
    const byte = parseInt(hexStr, 16);
    if (isNaN(byte)) {
        logDebugError("Invalid hex: " + hexStr);
        return;
    }
    sendCommand(byte, currentSpeed);
    logDebugError("Sent custom byte: 0x" + byte.toString(16).toUpperCase().padStart(2, "0"));
    playSound("drive");
};

// ============================================================
//  BLUETOOTH GATT CONNECTION
// ============================================================
async function connectCar() {
    if (connected) {
        disconnectCar();
        return;
    }

    try {
        setStatus("searching");
        logDebugError("Requesting Bluetooth device (YC_CAR_DEMO)...");

        bleDevice = await navigator.bluetooth.requestDevice({
            filters: [{ name: BLE_CONFIG.deviceName }],
            optionalServices: [BLE_CONFIG.serviceUuid]
        });

        bleDevice.addEventListener("gattserverdisconnected", onDisconnected);

        setStatus("connecting");
        bleServer = await bleDevice.gatt.connect();

        const service = await bleServer.getPrimaryService(BLE_CONFIG.serviceUuid);
        writeCharacteristic = await service.getCharacteristic(BLE_CONFIG.writeCharacteristicUuid);

        try {
            notifyCharacteristic = await service.getCharacteristic(BLE_CONFIG.notifyCharacteristicUuid);
            await notifyCharacteristic.startNotifications();
            notifyCharacteristic.addEventListener("characteristicvaluechanged", onNotification);
        } catch (e) {}

        connected = true;
        setStatus("connected");
        deviceLabel.textContent = bleDevice.name || "YC_CAR_DEMO";
        connectBtn.classList.add("connected");
        playSound("connect");
        triggerHaptic(70);

        if (debugDeviceName) debugDeviceName.textContent = bleDevice.name || "YC_CAR_DEMO";
        if (debugConnStatus) debugConnStatus.textContent = "Connected (OK)";
        logDebugError("Ready to drive!");

        sendCommand(CONTROL_MAP.STOP, 0x00);
    } catch (err) {
        logDebugError(err.message);
        setStatus("disconnected");
        cleanupBle();
    }
}

function disconnectCar() {
    stopAll(true);
    if (bleDevice && bleDevice.gatt.connected) {
        bleDevice.gatt.disconnect();
    }
    cleanupBle();
    setStatus("disconnected");
    deviceLabel.textContent = "CONNECT YC_CAR_DEMO";
    connectBtn.classList.remove("connected");
    playSound("disconnect");
}

function onDisconnected() {
    stopAll(false);
    cleanupBle();
    setStatus("disconnected");
    deviceLabel.textContent = "CONNECT YC_CAR_DEMO";
    connectBtn.classList.remove("connected");
    if (debugConnStatus) debugConnStatus.textContent = "Disconnected";
    playSound("disconnect");
}

function cleanupBle() {
    connected = false;
    writeCharacteristic = null;
    notifyCharacteristic = null;
    bleServer = null;
    totalPacketsSent = 0;
}

function onNotification(event) {
    const value = event.target.value;
    const bytes = [];
    for (let i = 0; i < value.byteLength; i++) {
        bytes.push(value.getUint8(i).toString(16).toUpperCase().padStart(2, "0"));
    }
    const hex = bytes.join(" ");
    if (debugLastRx) debugLastRx.textContent = "RX: " + hex;

    if (rxLed) {
        rxLed.classList.add("active");
        setTimeout(() => rxLed.classList.remove("active"), 50);
    }
}

function setStatus(state) {
    statusDot.className = "beacon-dot " + state;
}

function logDebugError(msg) {
    if (debugError) debugError.textContent = msg;
    console.log("[RC CAR]", msg);
}

// ============================================================
//  SAFETY MEASURES
// ============================================================
window.addEventListener("blur", () => stopAll(true));
document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAll(true);
});
window.addEventListener("pagehide", () => stopAll(true));

// ============================================================
//  INITIALIZE
// ============================================================
connectBtn.addEventListener("click", connectCar);
setupJoystick(steerPod, steerKnob, "steer");
setupJoystick(throttlePod, throttleKnob, "throttle");
updateSpeed(100);
