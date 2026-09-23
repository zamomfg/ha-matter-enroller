# Matter Enroller

Enroll Matter / Thread devices **without a phone**. Adds a sidebar panel with an
**"Enroll Thread Device"** button that scans the device's Matter QR code with
your browser camera (or accepts a typed pairing code), decodes it to a Matter
setup code, and commissions the device through Home Assistant's Matter Server —
while streaming the live commissioning logs.

- 📷 Camera QR scanning (native `BarcodeDetector` + bundled `jsQR` fallback)
- ⌨️ Manual `MT:` / pairing-code entry
- 🚀 One-click commissioning via `matter/commission`
- 📜 Live `matter_server` / `chip` log stream

Requires the **Matter integration** + **Matter Server**. Camera needs HTTPS or
localhost; otherwise use manual entry.
