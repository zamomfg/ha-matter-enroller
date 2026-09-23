"""Constants for the Matter Enroller integration."""

from __future__ import annotations

DOMAIN = "matter_enroller"

# URL the custom sidebar panel is mounted at.
PANEL_URL_PATH = "matter-enroller"
PANEL_TITLE = "Matter Enroller"
PANEL_ICON = "mdi:qrcode-scan"

# Static route the bundled frontend assets are served from.
STATIC_URL_BASE = "/matter_enroller_frontend"
PANEL_WEBCOMPONENT = "matter-enroller-panel"
PANEL_MODULE_URL = f"{STATIC_URL_BASE}/matter-enroller-panel.js"

# Loggers whose records are streamed to the panel while a device is enrolling.
# Adding a handler to a parent logger also captures its children (propagation),
# e.g. "chip" captures "chip.native"/"chip.DMG", "matter_server" captures
# "matter_server.client", etc.
STREAMED_LOGGERS: tuple[str, ...] = (
    "matter_server",
    "chip",
    "homeassistant.components.matter",
)
