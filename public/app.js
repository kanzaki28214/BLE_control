const SERVICE_UUID = "69321c59-8017-488e-b5e2-b6d30c834bc5";
const CHARACTERISTIC_UUID = "87bc2dc5-2207-408d-99f6-3d35573c4472";
const MAX_V = 0.15;
const MAX_W = 1.0;
const SEND_INTERVAL_MS = 50;

const state = {
  command: {
    vx: 0,
    vy: 0,
    w: 0,
    a: false,
    b: false,
    c: false,
    d: false,
    e: false,
    f: false,
    g: false,
    h: false,
  },
  odom: { x: 0, y: 0, yaw: 0 },
  connected: false,
  busy: false,
  path: [],
};

const el = {
  field: document.querySelector("#field"),
  connect: document.querySelector("#connectBtn"),
  status: document.querySelector("#statusText"),
  moveStick: document.querySelector("#moveStick"),
  moveKnob: document.querySelector(".move-knob"),
  turnStick: document.querySelector("#turnStick"),
  turnKnob: document.querySelector(".turn-knob"),
  pads: [...document.querySelectorAll(".pad")],
};

class PicomniBluetooth {
  device = null;
  server = null;
  characteristic = null;
  timer = null;
  writing = false;
  disconnectHandler = null;
  notifyHandler = null;

  async connect({ onNotify, onDisconnect }) {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID],
    });

    this.disconnectHandler = () => onDisconnect();
    device.addEventListener("gattserverdisconnected", this.disconnectHandler);

    const server = await device.gatt?.connect();
    if (!server) throw new Error("Failed to open GATT server.");

    const service = await server.getPrimaryService(SERVICE_UUID);
    const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);

    this.notifyHandler = (event) => {
      if (event.target.value) onNotify(event.target.value);
    };
    characteristic.addEventListener("characteristicvaluechanged", this.notifyHandler);
    await characteristic.startNotifications();

    this.device = device;
    this.server = server;
    this.characteristic = characteristic;
  }

  async disconnect() {
    this.stopCommandLoop();
    if (this.characteristic && this.notifyHandler) {
      this.characteristic.removeEventListener("characteristicvaluechanged", this.notifyHandler);
      try {
        await this.characteristic.stopNotifications();
      } catch {
        // Some Android builds throw if notifications are already stopped.
      }
    }
    if (this.server?.connected) this.server.disconnect();
    if (this.device && this.disconnectHandler) {
      this.device.removeEventListener("gattserverdisconnected", this.disconnectHandler);
    }
    this.device = null;
    this.server = null;
    this.characteristic = null;
    this.disconnectHandler = null;
    this.notifyHandler = null;
  }

  startCommandLoop(getCommand, onError) {
    if (this.timer !== null) return;
    this.timer = window.setInterval(async () => {
      if (this.writing) return;
      this.writing = true;
      try {
        await this.writeCommand(getCommand());
      } catch (error) {
        onError(error.message);
        this.stopCommandLoop();
      } finally {
        this.writing = false;
      }
    }, SEND_INTERVAL_MS);
  }

  stopCommandLoop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.writing = false;
  }

  async writeCommand(command) {
    if (!this.characteristic) throw new Error("BLE characteristic is not connected.");
    const payload = this.encodeCommand(command);
    if (this.characteristic.writeValueWithoutResponse) {
      await this.characteristic.writeValueWithoutResponse(payload);
    } else {
      await this.characteristic.writeValue(payload);
    }
  }

  encodeCommand(command) {
    const buffer = new ArrayBuffer(13);
    const view = new DataView(buffer);
    view.setFloat32(0, command.vx, true);
    view.setFloat32(4, command.vy, true);
    view.setFloat32(8, command.w, true);
    let buttons = 0;
    if (command.a) buttons |= 0x01;
    if (command.b) buttons |= 0x02;
    if (command.c) buttons |= 0x04;
    if (command.d) buttons |= 0x08;
    if (command.e) buttons |= 0x10;
    if (command.f) buttons |= 0x20;
    if (command.g) buttons |= 0x40;
    if (command.h) buttons |= 0x80;
    view.setUint8(12, buttons);
    return new Uint8Array(buffer);
  }
}

const ble = new PicomniBluetooth();

function setStatus(text) {
  el.status.textContent = text;
}

function setBusy(busy) {
  state.busy = busy;
  el.connect.disabled = busy;
  el.connect.textContent = busy ? "CONNECTING..." : state.connected ? "DISCONNECT" : "CONNECT";
}

function setConnected(connected) {
  state.connected = connected;
  el.connect.classList.toggle("connected", connected);
  el.connect.textContent = connected ? "DISCONNECT" : "CONNECT";
  setStatus(connected ? "ONLINE" : "OFFLINE");
}

function parseOdom(value) {
  if (value.byteLength < 12) throw new Error("Notification payload is shorter than 12 bytes.");
  return {
    x: value.getFloat32(0, true),
    y: value.getFloat32(4, true),
    yaw: value.getFloat32(8, true),
  };
}

async function connectRobot() {
  if (state.busy) return;
  if (!window.isSecureContext) {
    setStatus("HTTPS REQUIRED");
    window.alert("Web Bluetooth requires HTTPS. Open the Tailscale Serve HTTPS URL on Android.");
    return;
  }
  if (!navigator.bluetooth) {
    setStatus("WEB BLUETOOTH UNAVAILABLE");
    window.alert("This browser does not support Web Bluetooth. Use Chrome or Edge on Android.");
    return;
  }

  setBusy(true);
  try {
    await ble.connect({
      onNotify: (value) => {
        try {
          state.odom = parseOdom(value);
          state.path.push(state.odom);
          if (state.path.length > 400) state.path.shift();
        } catch (error) {
          setStatus(error.message);
        }
      },
      onDisconnect: () => {
        ble.stopCommandLoop();
        setConnected(false);
        setStatus("DISCONNECTED");
      },
    });
    setConnected(true);
    ble.startCommandLoop(() => state.command, (message) => setStatus(message));
  } catch (error) {
    setConnected(false);
    if (!String(error.name).includes("NotFoundError")) {
      setStatus(error.message);
      window.alert(error.message);
    }
  } finally {
    setBusy(false);
  }
}

async function disconnectRobot() {
  if (state.busy) return;
  setBusy(true);
  await ble.disconnect();
  state.path = [];
  setConnected(false);
  setBusy(false);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setupMoveStick() {
  let active = false;

  const reset = () => {
    active = false;
    el.moveKnob.style.transition = "transform 120ms ease";
    el.moveKnob.style.transform = "translate(-50%, -50%)";
    state.command.vx = 0;
    state.command.vy = 0;
  };

  const update = (event) => {
    const rect = el.moveStick.getBoundingClientRect();
    const radius = Math.max(24, rect.width / 2 - el.moveKnob.offsetWidth / 2 - 8);
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    const length = Math.hypot(dx, dy);
    const scale = length > radius ? radius / length : 1;
    const x = dx * scale;
    const y = dy * scale;
    el.moveKnob.style.transition = "none";
    el.moveKnob.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
    state.command.vx = (x / radius) * MAX_V;
    state.command.vy = (-y / radius) * MAX_V;
  };

  el.moveStick.addEventListener("pointerdown", (event) => {
    active = true;
    el.moveStick.setPointerCapture(event.pointerId);
    update(event);
  });
  el.moveStick.addEventListener("pointermove", (event) => {
    if (active) update(event);
  });
  el.moveStick.addEventListener("pointerup", reset);
  el.moveStick.addEventListener("pointercancel", reset);
  el.moveStick.addEventListener("pointerleave", () => {
    if (active) reset();
  });
}

function setupTurnStick() {
  let active = false;

  const reset = () => {
    active = false;
    el.turnKnob.style.transition = "left 120ms ease";
    el.turnKnob.style.left = "50%";
    state.command.w = 0;
  };

  const update = (event) => {
    const rect = el.turnStick.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left - rect.width / 2) / (rect.width / 2), -1, 1);
    el.turnKnob.style.transition = "none";
    el.turnKnob.style.left = `${(ratio + 1) * 50}%`;
    state.command.w = ratio * -MAX_W;
  };

  el.turnStick.addEventListener("pointerdown", (event) => {
    active = true;
    el.turnStick.setPointerCapture(event.pointerId);
    update(event);
  });
  el.turnStick.addEventListener("pointermove", (event) => {
    if (active) update(event);
  });
  el.turnStick.addEventListener("pointerup", reset);
  el.turnStick.addEventListener("pointercancel", reset);
  el.turnStick.addEventListener("pointerleave", () => {
    if (active) reset();
  });
}

function setupButtons() {
  for (const pad of el.pads) {
    const button = pad.dataset.button;
    const set = (active) => {
      state.command[button] = active;
      pad.classList.toggle("active", active);
    };
    pad.addEventListener("pointerdown", (event) => {
      pad.setPointerCapture(event.pointerId);
      set(true);
    });
    pad.addEventListener("pointerup", () => set(false));
    pad.addEventListener("pointercancel", () => set(false));
    pad.addEventListener("pointerleave", () => set(false));
  }
}

function formatValue(value) {
  return `${value < 0 ? "" : " "}${value.toFixed(2).padStart(5, " ")}`;
}

function drawArrow(ctx, x1, y1, x2, y2, label, dx, dy) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.strokeStyle = "#94a3b8";
  ctx.fillStyle = "#94a3b8";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.lineTo(x2 - 8 * Math.cos(angle - Math.PI / 6), y2 - 8 * Math.sin(angle - Math.PI / 6));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - 8 * Math.cos(angle + Math.PI / 6), y2 - 8 * Math.sin(angle + Math.PI / 6));
  ctx.stroke();
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillText(label, x2 + dx, y2 + dy);
}

function drawField() {
  const canvas = el.field;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, rect.width, rect.height);

  const cx = rect.width / 2;
  const cy = rect.height / 2;
  ctx.strokeStyle = "#1f2937";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, 0);
  ctx.lineTo(cx, rect.height);
  ctx.moveTo(0, cy);
  ctx.lineTo(rect.width, cy);
  ctx.stroke();

  drawArrow(ctx, cx, cy, cx + 80, cy, "+x", 8, 16);
  drawArrow(ctx, cx, cy, cx, cy - 80, "+y", 6, -10);

  const scale = rect.height / 2;
  if (state.path.length > 1) {
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < state.path.length; i += 1) {
      const point = state.path[i];
      const x = cx + point.x * scale;
      const y = cy - point.y * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillText(`vx:${formatValue(state.command.vx)} m/s`, 12, 24);
  ctx.fillText(`vy:${formatValue(state.command.vy)} m/s`, 12, 42);
  ctx.fillText(` w:${formatValue(state.command.w)} rad/s`, 12, 60);

  const robotX = cx + state.odom.x * scale;
  const robotY = cy - state.odom.y * scale;
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.fillText(`x:${state.odom.x.toFixed(2)} y:${state.odom.y.toFixed(2)} yaw:${state.odom.yaw.toFixed(2)}`, robotX + 10, robotY - 14);

  ctx.save();
  ctx.translate(robotX, robotY);
  ctx.rotate(-(state.odom.yaw + Math.PI / 2));
  ctx.fillStyle = "#22c55e";
  ctx.beginPath();
  ctx.moveTo(24, 0);
  ctx.lineTo(-12, 12);
  ctx.lineTo(-12, -12);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  requestAnimationFrame(drawField);
}

el.connect.addEventListener("click", () => {
  if (state.connected) disconnectRobot();
  else connectRobot();
});

setupMoveStick();
setupTurnStick();
setupButtons();
setConnected(false);
drawField();
