// Matter Enroller sidebar panel.
//
// Provides an "Enroll Thread Device" button that opens the browser camera to
// scan a Matter QR code (or lets you type the pairing code), decodes it to the
// numeric Matter setup / pairing code, and commissions the device through Home
// Assistant's built-in Matter integration (`matter/commission`) — while
// streaming the Matter Server / CHIP commissioning logs live.

import {
  parseMatterQrData,
  manualPairingCodeFromPayload,
  normalizeManualCode,
  extractMatterQrPayload,
} from "./matter-qr.js";

const JSQR_URL = "/matter_enroller_frontend/jsqr.js";

let jsQRPromise = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (jsQRPromise) return jsQRPromise;
  jsQRPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = JSQR_URL;
    script.onload = () => resolve(window.jsQR);
    script.onerror = () => reject(new Error("Failed to load QR decoder."));
    document.head.appendChild(script);
  });
  return jsQRPromise;
}

class MatterEnrollerPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._rendered = false;
    this._stream = null;
    this._scanning = false;
    this._rafId = null;
    this._detector = null;
    this._logUnsub = null;
    this._logLines = [];
    this._parsed = null; // { payload, code, source }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._rendered) {
      this._render();
      this._rendered = true;
      this._subscribeLogs();
    }
  }
  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (this._hass && !this._rendered) {
      this._render();
      this._rendered = true;
      this._subscribeLogs();
    }
  }

  disconnectedCallback() {
    this._stopScanner();
    if (this._logUnsub) {
      this._logUnsub.then((unsub) => unsub && unsub()).catch(() => {});
      this._logUnsub = null;
    }
  }

  // ---- rendering -----------------------------------------------------------

  _render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 16px;
          max-width: 880px;
          margin: 0 auto;
          color: var(--primary-text-color);
          font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
        }
        h1 { font-size: 22px; font-weight: 500; margin: 8px 0 4px; }
        .subtitle { color: var(--secondary-text-color); margin: 0 0 16px; font-size: 14px; }
        .card {
          background: var(--card-background-color, #fff);
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,.1));
          padding: 16px;
          margin-bottom: 16px;
        }
        button {
          font: inherit;
          cursor: pointer;
          border: none;
          border-radius: 8px;
          padding: 10px 18px;
          background: var(--primary-color, #03a9f4);
          color: var(--text-primary-color, #fff);
        }
        button.secondary {
          background: transparent;
          color: var(--primary-color, #03a9f4);
          border: 1px solid var(--divider-color, #ccc);
        }
        button:disabled { opacity: .5; cursor: not-allowed; }
        button.big { font-size: 16px; padding: 14px 22px; display: inline-flex; align-items: center; gap: 8px; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .hidden { display: none !important; }
        video { width: 100%; max-width: 480px; border-radius: 8px; background: #000; }
        canvas { display: none; }
        input[type="text"] {
          font: inherit; padding: 10px; border-radius: 8px;
          border: 1px solid var(--divider-color, #ccc);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          width: 240px; max-width: 100%;
        }
        .fields { display: grid; grid-template-columns: auto 1fr; gap: 4px 16px; font-size: 14px; margin-top: 8px; }
        .fields dt { color: var(--secondary-text-color); }
        .fields dd { margin: 0; font-variant-numeric: tabular-nums; }
        .code {
          font-size: 24px; font-weight: 600; letter-spacing: 2px;
          font-variant-numeric: tabular-nums; margin: 8px 0;
        }
        .status { margin-top: 8px; font-size: 14px; }
        .status.ok { color: var(--success-color, #4caf50); }
        .status.err { color: var(--error-color, #f44336); }
        .logs {
          background: #0b0f14; color: #cfd8dc; border-radius: 8px;
          padding: 10px; height: 280px; overflow-y: auto;
          font-family: var(--code-font-family, "Roboto Mono", monospace);
          font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
        }
        .log-INFO { color: #b3e5fc; }
        .log-DEBUG { color: #90a4ae; }
        .log-WARNING { color: #ffd54f; }
        .log-ERROR, .log-CRITICAL { color: #ef9a9a; }
        .log-name { color: #7e9cc0; }
        .muted { color: var(--secondary-text-color); font-size: 13px; }
        label { display: block; margin: 12px 0 4px; font-size: 13px; color: var(--secondary-text-color); }
        select {
          font: inherit; padding: 10px; border-radius: 8px;
          border: 1px solid var(--divider-color, #ccc);
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color); max-width: 100%;
        }
        .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 8px; }
        .chip {
          border: 1px solid var(--divider-color, #ccc); border-radius: 16px;
          padding: 4px 12px; cursor: pointer; font-size: 13px; user-select: none;
        }
        .chip.selected {
          background: var(--primary-color, #03a9f4);
          color: var(--text-primary-color, #fff);
          border-color: var(--primary-color, #03a9f4);
        }
        .chip.new { border-style: dashed; }
        #device-setup strong { font-size: 16px; }
      </style>

      <h1>Enroll Matter / Thread Device</h1>
      <p class="subtitle">Scan the device's Matter QR code with your camera, or type the pairing code — no phone required.</p>

      <div class="card">
        <div class="row" id="actions">
          <button class="big" id="scan-btn">📷 Enroll Thread Device</button>
          <button class="secondary" id="photo-btn">📸 Scan QR from photo</button>
          <button class="secondary" id="manual-btn">⌨️ Enter pairing code</button>
        </div>
        <input type="file" id="photo-input" accept="image/*" capture="environment" class="hidden" />
        <p class="muted" id="photo-hint" style="margin-top:8px;">Over HTTP (incl. the mobile app), live camera is blocked by the browser — use <strong>📸 Scan QR from photo</strong> or type the code.<br />
        <strong>Home Assistant Android app:</strong> it can only open the photo gallery, not the camera (app limitation). Snap the QR with your Camera app first, then pick it — or open this page in <strong>Chrome</strong>, where the button opens the camera directly (works over HTTP too).</p>

        <div id="scanner" class="hidden" style="margin-top:12px;">
          <video id="video" playsinline muted></video>
          <canvas id="canvas"></canvas>
          <div class="row" style="margin-top:8px;">
            <button class="secondary" id="stop-btn">Stop camera</button>
            <span class="muted" id="scan-hint">Point the camera at the Matter QR code…</span>
          </div>
        </div>

        <div id="manual" class="hidden" style="margin-top:12px;">
          <div class="row">
            <input type="text" id="manual-input" placeholder="MT:… or 1234-567-8901" autocomplete="off" />
            <button id="manual-submit">Use code</button>
          </div>
          <p class="muted">Paste the full <code>MT:</code> QR string or the 11 / 21-digit manual pairing code.</p>
        </div>

        <div id="result" class="hidden" style="margin-top:12px;">
          <div>Matter setup / pairing code:</div>
          <div class="code" id="result-code">—</div>
          <dl class="fields" id="result-fields"></dl>
          <div class="row" style="margin-top:12px;">
            <button id="commission-btn">🚀 Commission Thread device</button>
            <button class="secondary" id="reset-btn">Clear</button>
          </div>
          <div class="status" id="status"></div>
        </div>
      </div>

      <div class="card hidden" id="device-setup">
        <strong>✅ New device</strong>
        <div id="device-setup-body"></div>
      </div>

      <div class="card">
        <div class="row" style="justify-content: space-between;">
          <strong>Matter Server logs</strong>
          <button class="secondary" id="clear-logs">Clear</button>
        </div>
        <div class="logs" id="logs"></div>
      </div>
    `;

    this._$ = (id) => this.shadowRoot.getElementById(id);

    this._$("scan-btn").addEventListener("click", () => this._startScanner());
    this._$("stop-btn").addEventListener("click", () => this._stopScanner());
    this._$("photo-btn").addEventListener("click", () => this._pickPhoto());
    this._$("photo-input").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      this._scanFromPhoto(file);
    });
    this._$("manual-btn").addEventListener("click", () => this._toggleManual());
    this._$("manual-submit").addEventListener("click", () =>
      this._handleManual()
    );
    this._$("manual-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this._handleManual();
    });
    this._$("commission-btn").addEventListener("click", () =>
      this._commission()
    );
    this._$("reset-btn").addEventListener("click", () => this._resetResult());
    this._$("clear-logs").addEventListener("click", () => {
      this._logLines = [];
      this._$("logs").textContent = "";
    });
  }

  // ---- camera scanning -----------------------------------------------------

  async _startScanner() {
    this._resetResult();
    this._$("manual").classList.add("hidden");
    this._$("scanner").classList.remove("hidden");
    const hint = this._$("scan-hint");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this._$("scanner").classList.add("hidden");
      this._showError(
        "Live camera needs HTTPS (or localhost) — your HA is served over HTTP, so the browser blocks it. " +
          "Use “📸 Scan QR from photo” (opens your phone/computer camera) or “⌨️ Enter pairing code”."
      );
      return;
    }

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
    } catch (err) {
      this._$("scanner").classList.add("hidden");
      this._showError(
        `Could not open camera: ${err.message}. Use “📸 Scan QR from photo” or “⌨️ Enter pairing code”.`
      );
      return;
    }

    const video = this._$("video");
    video.srcObject = this._stream;
    await video.play().catch(() => {});

    // Prefer the native BarcodeDetector; fall back to jsQR.
    this._detector = null;
    if ("BarcodeDetector" in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes("qr_code")) {
          this._detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        }
      } catch (_) {
        this._detector = null;
      }
    }
    if (!this._detector) {
      try {
        await loadJsQR();
      } catch (err) {
        hint.textContent = err.message;
      }
    }

    this._scanning = true;
    this._scanLoop();
  }

  async _scanLoop() {
    if (!this._scanning) return;
    const video = this._$("video");

    let text = null;
    try {
      if (this._detector && video.readyState >= 2) {
        const codes = await this._detector.detect(video);
        if (codes && codes.length) text = codes[0].rawValue;
      } else if (window.jsQR && video.readyState >= 2) {
        const canvas = this._$("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = window.jsQR(img.data, img.width, img.height);
        if (result) text = result.data;
      }
    } catch (_) {
      // transient decode error — keep scanning
    }

    if (text && text.toUpperCase().includes("MT:")) {
      this._stopScanner();
      this._acceptScanned(text);
      return;
    }

    this._rafId = requestAnimationFrame(() => this._scanLoop());
  }

  _stopScanner() {
    this._scanning = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
    }
    const video = this._$("video");
    if (video) video.srcObject = null;
    this._$("scanner").classList.add("hidden");
  }

  // ---- photo scan (works over HTTP / in the mobile app) --------------------
  // Uses <input type="file" capture> so the native camera app takes a still
  // photo, which we decode with jsQR — no getUserMedia / HTTPS required.

  _pickPhoto() {
    this._stopScanner();
    this._$("manual").classList.add("hidden");
    const input = this._$("photo-input");
    input.value = "";
    input.click();
  }

  async _scanFromPhoto(file) {
    if (!file) return;
    this._resetResult();

    try {
      await loadJsQR();
    } catch (err) {
      this._showError(err.message);
      return;
    }

    try {
      const image = await this._loadImage(file);
      const canvas = this._$("canvas");
      const maxDim = 1600;
      const scale = Math.min(1, maxDim / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0, width, height);
      const img = ctx.getImageData(0, 0, width, height);
      const result = window.jsQR(img.data, img.width, img.height);

      if (result && result.data && result.data.toUpperCase().includes("MT:")) {
        this._acceptScanned(result.data);
      } else if (result && result.data) {
        this._showError("That QR code isn't a Matter code (no MT: payload).");
      } else {
        this._showError(
          "No QR code found in the photo. Try again — get closer, fill the frame, and keep it well-lit and in focus."
        );
      }
    } catch (err) {
      this._showError(`Could not read the photo: ${err.message}`);
    }
  }

  _loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("unsupported image file"));
      };
      image.src = url;
    });
  }

  // ---- code handling -------------------------------------------------------

  _acceptScanned(text) {
    try {
      const payload = parseMatterQrData(text);
      if (!payload) throw new Error("Not a Matter QR code.");
      const code = manualPairingCodeFromPayload(payload);
      this._showResult({ payload, code, source: "QR code" });
    } catch (err) {
      this._showError(`Could not decode QR: ${err.message}`);
    }
  }

  _toggleManual() {
    this._stopScanner();
    this._$("manual").classList.toggle("hidden");
  }

  _handleManual() {
    const raw = this._$("manual-input").value.trim();
    if (!raw) return;

    try {
      if (raw.toUpperCase().includes("MT:") && extractMatterQrPayload(raw)) {
        const payload = parseMatterQrData(raw);
        const code = manualPairingCodeFromPayload(payload);
        this._showResult({ payload, code, source: "QR string" });
      } else {
        const digits = normalizeManualCode(raw);
        if (digits.length !== 11 && digits.length !== 21) {
          throw new Error(
            "Manual pairing codes are 11 digits (or 21 for a custom-flow device)."
          );
        }
        this._showResult({ payload: null, code: digits, source: "manual entry" });
      }
    } catch (err) {
      this._showError(err.message);
    }
  }

  _showResult({ payload, code, source }) {
    this._parsed = { payload, code, source };
    this._$("result").classList.remove("hidden");
    this._$("result-code").textContent = this._formatCode(code);
    this._$("status").textContent = "";
    this._$("status").className = "status";
    this._$("commission-btn").disabled = false;

    const fields = this._$("result-fields");
    fields.innerHTML = "";
    const rows = [["Source", source]];
    if (payload) {
      rows.push(
        ["Vendor ID", `0x${payload.vendorId.toString(16).toUpperCase()} (${payload.vendorId})`],
        ["Product ID", `0x${payload.productId.toString(16).toUpperCase()} (${payload.productId})`],
        ["Discriminator", payload.discriminator],
        ["Setup PIN", payload.setupPinCode],
        [
          "Commissioning flow",
          payload.commissioningFlow === 0 ? "Standard" : `Custom (${payload.commissioningFlow})`,
        ]
      );
    }
    for (const [k, v] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = String(v);
      fields.append(dt, dd);
    }
  }

  _formatCode(code) {
    if (code.length === 11) {
      return `${code.slice(0, 4)}-${code.slice(4, 7)}-${code.slice(7)}`;
    }
    return code.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
  }

  _showError(message) {
    this._$("result").classList.remove("hidden");
    this._$("commission-btn").disabled = true;
    const status = this._$("status");
    status.textContent = message;
    status.className = "status err";
  }

  _resetResult() {
    this._parsed = null;
    this._$("result").classList.add("hidden");
    this._$("result-code").textContent = "—";
    this._$("result-fields").innerHTML = "";
    this._$("status").textContent = "";
    const ds = this._$("device-setup");
    if (ds) ds.classList.add("hidden");
    const input = this._$("manual-input");
    if (input) input.value = "";
  }

  // ---- commissioning -------------------------------------------------------

  async _commission() {
    if (!this._parsed || !this._hass) return;
    const status = this._$("status");
    const btn = this._$("commission-btn");
    btn.disabled = true;
    status.className = "status";
    status.textContent = "⏳ Commissioning… watch the logs below. This can take up to a minute.";

    // Snapshot existing Matter devices so we can spot the newly added one.
    const before = await this._matterDeviceIds();

    try {
      await this._hass.connection.sendMessagePromise({
        type: "matter/commission",
        code: this._parsed.code,
        // network_only:false → allow BLE commissioning of a fresh Thread/Wi-Fi
        // device that is not yet on the network.
        network_only: false,
      });
      status.className = "status ok";
      status.textContent = "✅ Device commissioned successfully.";
      this._presentNewDevice(before);
    } catch (err) {
      status.className = "status err";
      const msg = err && (err.message || err.code) ? err.message || err.code : err;
      status.textContent = `❌ Commissioning failed: ${msg}`;
      btn.disabled = false;
    }
  }

  // ---- post-enrollment device setup ---------------------------------------

  _ws(msg) {
    return this._hass.connection.sendMessagePromise(msg);
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async _matterDeviceIds() {
    try {
      const devices = await this._ws({ type: "config/device_registry/list" });
      return new Set(
        devices
          .filter((d) => this._isMatterDevice(d))
          .map((d) => d.id)
      );
    } catch (_) {
      return new Set();
    }
  }

  _isMatterDevice(device) {
    return (device.identifiers || []).some(
      (i) => Array.isArray(i) && i[0] === "matter"
    );
  }

  // Poll the device registry until a Matter device appears that wasn't there
  // before commissioning, then show the setup card for it.
  async _presentNewDevice(before) {
    let device = null;
    for (let attempt = 0; attempt < 12 && !device; attempt += 1) {
      const devices = await this._ws({
        type: "config/device_registry/list",
      }).catch(() => []);
      device =
        devices.find((d) => this._isMatterDevice(d) && !before.has(d.id)) ||
        null;
      if (!device) await this._sleep(1500);
    }

    const card = this._$("device-setup");
    const body = this._$("device-setup-body");
    card.classList.remove("hidden");
    body.innerHTML = "";

    if (!device) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent =
        "Device commissioned, but it hasn't shown up in the device list yet. ";
      const a = document.createElement("a");
      a.textContent = "Open the Matter integration →";
      a.href = "/config/integrations/integration/matter";
      p.appendChild(a);
      body.appendChild(p);
      return;
    }

    this._newDevice = device;
    await this._renderDeviceSetup(device, body);
  }

  _openDevice(deviceId) {
    const url = `/config/devices/device/${deviceId}`;
    window.history.pushState(null, "", url);
    // Home Assistant's root element listens for this on window and routes
    // without a full page reload.
    window.dispatchEvent(new CustomEvent("location-changed"));
  }

  _fieldLabel(text) {
    const el = document.createElement("label");
    el.textContent = text;
    return el;
  }

  async _renderDeviceSetup(device, body) {
    const [areas, labels] = await Promise.all([
      this._ws({ type: "config/area_registry/list" }).catch(() => []),
      this._ws({ type: "config/label_registry/list" }).catch(() => []),
    ]);

    const currentName = device.name_by_user || device.name || "Matter device";

    // Heading + "open device" button.
    const head = document.createElement("div");
    head.className = "row";
    head.style.justifyContent = "space-between";
    const title = document.createElement("div");
    title.append(document.createTextNode("Added "));
    const strong = document.createElement("strong");
    strong.textContent = currentName;
    title.append(strong);
    const openBtn = document.createElement("button");
    openBtn.textContent = "Open device →";
    openBtn.addEventListener("click", () => this._openDevice(device.id));
    head.append(title, openBtn);
    body.append(head);

    // Name.
    body.append(this._fieldLabel("Name"));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = device.name_by_user || device.name || "";
    nameInput.style.width = "100%";
    body.append(nameInput);

    // Area (existing dropdown + inline create).
    body.append(this._fieldLabel("Area"));
    const areaRow = document.createElement("div");
    areaRow.className = "row";
    const areaSelect = document.createElement("select");
    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "— No area —";
    areaSelect.append(noneOpt);
    for (const a of areas) {
      const o = document.createElement("option");
      o.value = a.area_id;
      o.textContent = a.name;
      if (device.area_id === a.area_id) o.selected = true;
      areaSelect.append(o);
    }
    const newAreaInput = document.createElement("input");
    newAreaInput.type = "text";
    newAreaInput.placeholder = "or new area name";
    areaRow.append(areaSelect, newAreaInput);
    body.append(areaRow);

    // Labels / tags (existing chips toggle + inline create).
    body.append(this._fieldLabel("Labels / tags"));
    const chips = document.createElement("div");
    chips.className = "chips";
    const selected = new Set(device.labels || []);
    for (const l of labels) {
      const chip = document.createElement("span");
      chip.className = "chip" + (selected.has(l.label_id) ? " selected" : "");
      chip.textContent = l.name;
      chip.addEventListener("click", () => {
        if (selected.has(l.label_id)) {
          selected.delete(l.label_id);
          chip.classList.remove("selected");
        } else {
          selected.add(l.label_id);
          chip.classList.add("selected");
        }
      });
      chips.append(chip);
    }
    body.append(chips);
    const newLabelInput = document.createElement("input");
    newLabelInput.type = "text";
    newLabelInput.placeholder = "add new label, press Enter";
    const pendingLabels = [];
    newLabelInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const name = newLabelInput.value.trim();
      if (!name || pendingLabels.includes(name)) return;
      pendingLabels.push(name);
      const chip = document.createElement("span");
      chip.className = "chip selected new";
      chip.textContent = name;
      chips.append(chip);
      newLabelInput.value = "";
    });
    body.append(newLabelInput);

    // Save.
    const saveRow = document.createElement("div");
    saveRow.className = "row";
    saveRow.style.marginTop = "14px";
    const saveBtn = document.createElement("button");
    saveBtn.textContent = "💾 Save";
    const devStatus = document.createElement("span");
    devStatus.className = "status";
    saveRow.append(saveBtn, devStatus);
    body.append(saveRow);

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      devStatus.className = "status";
      devStatus.textContent = "Saving…";
      try {
        let areaId = areaSelect.value || null;
        const newAreaName = newAreaInput.value.trim();
        if (newAreaName) {
          const area = await this._ws({
            type: "config/area_registry/create",
            name: newAreaName,
          });
          areaId = area.area_id;
        }

        const labelIds = new Set(selected);
        for (const name of pendingLabels) {
          const lbl = await this._ws({
            type: "config/label_registry/create",
            name,
          });
          labelIds.add(lbl.label_id);
        }

        await this._ws({
          type: "config/device_registry/update",
          device_id: device.id,
          name_by_user: nameInput.value.trim() || null,
          area_id: areaId,
          labels: Array.from(labelIds),
        });

        devStatus.className = "status ok";
        devStatus.textContent = "✅ Saved";
      } catch (err) {
        devStatus.className = "status err";
        devStatus.textContent = `❌ ${err.message || err.code || err}`;
        saveBtn.disabled = false;
      }
    });
  }

  // ---- log streaming -------------------------------------------------------

  _subscribeLogs() {
    if (!this._hass || this._logUnsub) return;
    this._logUnsub = this._hass.connection
      .subscribeMessage((event) => this._appendLog(event), {
        type: "matter_enroller/subscribe_logs",
      })
      .catch((err) => {
        this._appendLog({
          level: "ERROR",
          name: "matter_enroller",
          message: `Could not subscribe to logs: ${err.message || err.code || err}`,
        });
        return null;
      });
  }

  _appendLog(entry) {
    const logs = this._$("logs");
    if (!logs) return;
    const line = document.createElement("div");
    const level = (entry.level || "INFO").toUpperCase();
    line.className = `log-${level}`;
    const name = entry.name ? `${entry.name}: ` : "";
    line.textContent = `[${level}] ${name}${entry.message || ""}`;
    logs.appendChild(line);

    // Cap retained lines to keep the DOM light.
    this._logLines.push(line);
    if (this._logLines.length > 500) {
      const old = this._logLines.shift();
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }

    const atBottom =
      logs.scrollHeight - logs.scrollTop - logs.clientHeight < 60;
    if (atBottom) logs.scrollTop = logs.scrollHeight;
  }
}

customElements.define("matter-enroller-panel", MatterEnrollerPanel);
