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

- 📷 **Camera QR scanning** — live scanning via the native `BarcodeDetector` API
  where available, with a bundled [`jsQR`](https://github.com/cozmo/jsQR)
  fallback.
- 📱 **Native scanner in the HA mobile app** — inside the Home Assistant
  companion app, the Enroll button uses the app's own built-in barcode scanner
  (real camera, works over HTTP) via the external bus.
- 📸 **Photo scanning (browser / HTTP)** — a "Scan QR from photo" option that
  opens the native camera (or a file picker on desktop) and decodes the still
  image. Works even over plain HTTP where live camera is blocked.
- ⌨️ **Manual entry** — paste the full `MT:…` QR string or the 11 / 21-digit
  manual pairing code.
- 🔎 **Decodes the payload** — shows Vendor ID, Product ID, discriminator,
  setup PIN and commissioning flow (base38 → TLV bit-unpack → Verhoeff manual
  code), matching the Matter onboarding spec.
- 🚀 **One-click commissioning** — calls Home Assistant's built-in
  `matter/commission` websocket command with `network_only: false` so a fresh
  Thread/Wi-Fi device can be commissioned over BLE. Includes a **✋ Cancel**
  button to stop waiting on a stuck pair (see the note about Matter's lack of a
  true abort API).
- 📜 **Live log stream** — streams the **Matter Server add-on** logs via the
  Supervisor API (the detailed CHIP/commissioning logs), plus Home Assistant's
  in-process Matter client logs, so you can watch the device commission in real
  time.
- 🏷️ **Post-enrollment setup** — just like ZHA/Zigbee pairing: once the device is
  added, jump straight to it, rename it, assign an **area** (create one inline),
  and set **labels/tags** (create them inline) without leaving the panel.

## Requirements

- Home Assistant **2024.7+** (with the async static-path API).
- The **[Matter integration](https://www.home-assistant.io/integrations/matter/)**
  set up and connected to a running **Matter Server** add-on / container.
- For Thread devices: a working **Thread border router (OTBR)** with an active
  dataset, and **Bluetooth** available to Home Assistant (built-in adapter or an
  ESP32 Bluetooth proxy in *active* mode) so the device can be commissioned over
  BLE.
- **Scanning by platform:**
  - **In the Home Assistant mobile app** the Enroll button uses the app's
    **native barcode scanner** (real camera), so it works fine even over plain
    HTTP — no HTTPS needed.
  - **In a browser**, live scanning uses `getUserMedia`, which only works over
    **HTTPS** or **`localhost`**. Over plain `http://` the browser blocks it —
    use **📸 Scan QR from photo** (opens the native camera / a file picker; the
    still image is decoded locally, works over HTTP) or **⌨️ Enter pairing code**.
    For a live viewfinder in the browser, serve HA over HTTPS (Nabu Casa Cloud or
    a reverse proxy with a valid certificate).

  > Note: the older photo-upload path in the HA **Android** app opens the gallery
  > rather than the camera ([home-assistant/android#6055](https://github.com/home-assistant/android/issues/6055));
  > that's why the app uses the native scanner instead.

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
4. Watch the **Matter Server logs** panel while the device commissions.
5. When it's done, a **New device** card appears (like Zigbee pairing): click
   **Open device →** to jump to it, or right there **rename** it, pick/create an
   **area**, and add/create **labels (tags)**, then **Save**.

## How it works

| Piece | Implementation |
| --- | --- |
| QR decode | `frontend/matter-qr.js` — base38 decode, bit-unpack the TLV header, build the manual pairing code with a Verhoeff check digit (verified against the canonical Matter test vector `MT:Y.K9042C00KA0648G00`). |
| Commissioning | The panel calls the built-in `matter/commission` websocket command (`code` accepts either the raw `MT:` payload or the manual code). |
| Native app scan | In the HA companion app, uses the external bus (`bar_code/scan` / `bar_code/close` and the `bar_code/scan_result` command) exposed via `hass.auth.external`, gated on `config.hasBarCodeScanner`. |
| Log stream | `matter_enroller/subscribe_logs` follows the **Matter Server add-on** logs via the Supervisor API (`GET http://supervisor/addons/core_matter_server/logs/follow`) and also attaches a handler to the in-process `matter_server` / `chip` client loggers. |
| Post-enroll setup | Diffs the Matter device list before/after commissioning to find the new device, then uses HA's `config/device_registry/update`, `config/area_registry/{list,create}` and `config/label_registry/{list,create}` websocket commands to rename it and set its area and labels. |

## Notes & limitations

- This integration does **not** replace the Matter integration — it drives it.
- If commissioning fails with a credentials error, make sure your Thread dataset
  (OTBR) and/or Wi-Fi credentials are configured; the Matter integration handles
  providing these during commissioning.
- **Cancel is best-effort.** Matter Server / python-matter-server exposes **no
  API to abort an in-progress commission**. The ✋ Cancel button only stops the
  panel from waiting — the server keeps going until it succeeds or times out
  (~1–2 min). If the device paired anyway, it appears under the Matter integration.
- **Add-on logs need Supervisor.** The detailed Matter Server logs are streamed
  from the add-on via the Supervisor API. On Container/Core installs (no
  Supervisor) only Home Assistant's in-process Matter *client* logs are shown. If
  your add-on uses a non-standard slug, update `_ADDON_SLUGS` in `websocket_api.py`.
- **Troubleshooting the scanner:** open the panel's top-right **⋮ menu →
  🐞 Diagnostics** to see the detected environment (native scanner availability,
  secure context, `getUserMedia`/`BarcodeDetector` support, etc.).
- Bundled `jsQR` is vendored under `frontend/jsqr.js` (MIT).

## License

MIT
