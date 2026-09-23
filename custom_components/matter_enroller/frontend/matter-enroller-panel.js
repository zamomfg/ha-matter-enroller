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
      </style>

      <h1>Enroll Matter / Thread Device</h1>
      <p class="subtitle">Scan the device's Matter QR code with your camera, or type the pairing code — no phone required.</p>

      <div class="card">
        <div class="row" id="actions">
          <button class="big" id="scan-btn">📷 Enroll Thread Device</button>
          <button class="secondary" id="manual-btn">⌨️ Enter pairing code</button>
        </div>

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
      hint.textContent =
        "Camera unavailable. HTTPS (or localhost) is required for camera access — use “Enter pairing code” instead.";
      return;
    }

    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
    } catch (err) {
      hint.textContent = `Could not open camera: ${err.message}. Use “Enter pairing code” instead.`;
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
    } catch (err) {
      status.className = "status err";
      const msg = err && (err.message || err.code) ? err.message || err.code : err;
      status.textContent = `❌ Commissioning failed: ${msg}`;
      btn.disabled = false;
    }
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
