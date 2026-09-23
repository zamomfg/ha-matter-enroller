# Matter Enroller for Home Assistant

Enroll Matter / Thread devices **without a phone**, straight from the Home
Assistant web UI. Adds a sidebar panel with an **"Enroll Thread Device"** button
that opens your browser camera to scan the device's Matter QR code (or lets you
type the pairing code), decodes it to a Matter setup / pairing code exactly like
[`chill-uk/matter-qr-app`](https://github.com/chill-uk/matter-qr-app), and
commissions the device through Home Assistant's Matter Server — while streaming
the live commissioning logs.

Inspired by the manual approach in
[SmartHomeScene's guide](https://smarthomescene.com/guides/add-matter-devices-home-assistant-without-phone/),
but packaged as a one-click, HACS-installable integration.

## Features

- 📷 **Camera QR scanning** — uses the native `BarcodeDetector` API where
  available, with a bundled [`jsQR`](https://github.com/cozmo/jsQR) fallback.
- ⌨️ **Manual entry** — paste the full `MT:…` QR string or the 11 / 21-digit
  manual pairing code.
- 🔎 **Decodes the payload** — shows Vendor ID, Product ID, discriminator,
  setup PIN and commissioning flow (base38 → TLV bit-unpack → Verhoeff manual
  code), matching the Matter onboarding spec.
- 🚀 **One-click commissioning** — calls Home Assistant's built-in
  `matter/commission` websocket command with `network_only: false` so a fresh
  Thread/Wi-Fi device can be commissioned over BLE.
- 📜 **Live log stream** — tails the `matter_server` and `chip` loggers in real
  time so you can watch the device commission.

## Requirements

- Home Assistant **2024.7+** (with the async static-path API).
- The **[Matter integration](https://www.home-assistant.io/integrations/matter/)**
  set up and connected to a running **Matter Server** add-on / container.
- For Thread devices: a working **Thread border router (OTBR)** with an active
  dataset, and **Bluetooth** available to Home Assistant (built-in adapter or an
  ESP32 Bluetooth proxy in *active* mode) so the device can be commissioned over
  BLE.
- **Camera access requires a secure context.** Browsers only expose the camera
  over **HTTPS** or on **`localhost`**. If you open Home Assistant over plain
  `http://` on your LAN, use the *Enter pairing code* option instead (or set up
  HTTPS / Nabu Casa).

## Installation

### Via HACS (recommended)

1. HACS → ⋮ → **Custom repositories** → add this repo's URL, category
   **Integration**.
2. Search for **Matter Enroller**, install it.
3. Restart Home Assistant.
4. **Settings → Devices & Services → Add Integration → Matter Enroller.**

### Manual

Copy `custom_components/matter_enroller` into your Home Assistant
`config/custom_components/` directory, restart, then add the integration from
**Settings → Devices & Services**.

## Usage

1. Open **Matter Enroller** in the sidebar.
2. Click **Enroll Thread Device** and point the camera at the device's Matter QR
   code — or click **Enter pairing code** and paste the `MT:` string / manual
   code.
3. Review the decoded setup code and details, then click **Commission Thread
   device**.
4. Watch the **Matter Server logs** panel while the device commissions. On
   success the device appears under the Matter integration.

## How it works

| Piece | Implementation |
| --- | --- |
| QR decode | `frontend/matter-qr.js` — base38 decode, bit-unpack the TLV header, build the manual pairing code with a Verhoeff check digit (verified against the canonical Matter test vector `MT:Y.K9042C00KA0648G00`). |
| Commissioning | The panel calls the built-in `matter/commission` websocket command (`code` accepts either the raw `MT:` payload or the manual code). |
| Log stream | `matter_enroller/subscribe_logs` attaches a log handler to the `matter_server` / `chip` loggers and forwards records over the websocket connection. |

## Notes & limitations

- This integration does **not** replace the Matter integration — it drives it.
- If commissioning fails with a credentials error, make sure your Thread dataset
  (OTBR) and/or Wi-Fi credentials are configured; the Matter integration handles
  providing these during commissioning.
- Bundled `jsQR` is vendored under `frontend/jsqr.js` (MIT).

## License

MIT
