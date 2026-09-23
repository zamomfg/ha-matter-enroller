"""The Matter Enroller integration.

Registers a sidebar panel that lets you enroll (commission) Matter/Thread
devices without a phone: scan the device's QR code with the browser camera or
type the pairing code, then commission it through Home Assistant's Matter Server
while watching the live commissioning logs.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import (
    DOMAIN,
    PANEL_ICON,
    PANEL_MODULE_URL,
    PANEL_TITLE,
    PANEL_URL_PATH,
    PANEL_WEBCOMPONENT,
    STATIC_URL_BASE,
)
from .websocket_api import async_register as async_register_ws

_LOGGER = logging.getLogger(__name__)

FRONTEND_DIR = Path(__file__).parent / "frontend"


async def _async_register_static_path(hass: HomeAssistant) -> None:
    """Serve the bundled frontend assets, supporting old and new HA APIs."""
    if getattr(hass.data, "get", None) and hass.data.get(f"{DOMAIN}_static"):
        return
    hass.data[f"{DOMAIN}_static"] = True

    try:
        # Home Assistant 2024.7+ async API.
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL_BASE, str(FRONTEND_DIR), False)]
        )
    except ImportError:
        # Fallback for older cores.
        hass.http.register_static_path(  # type: ignore[attr-defined]
            STATIC_URL_BASE, str(FRONTEND_DIR), cache_headers=False
        )


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Matter Enroller from a config entry."""
    async_register_ws(hass)
    await _async_register_static_path(hass)

    if PANEL_URL_PATH not in hass.data.get("frontend_panels", {}):
        await panel_custom.async_register_panel(
            hass,
            frontend_url_path=PANEL_URL_PATH,
            webcomponent_name=PANEL_WEBCOMPONENT,
            module_url=f"{PANEL_MODULE_URL}?v={entry.version}",
            sidebar_title=PANEL_TITLE,
            sidebar_icon=PANEL_ICON,
            require_admin=True,
            config={},
        )

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    return True
