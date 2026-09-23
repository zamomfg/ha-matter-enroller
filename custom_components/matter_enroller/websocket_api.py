"""WebSocket API for the Matter Enroller integration.

The Matter *commissioning* itself is performed with the command that Home
Assistant's built-in Matter integration already exposes (``matter/commission``),
so the frontend calls that directly. This module adds a live log stream so the
user can watch a Thread device being commissioned in real time.

The detailed commissioning / CHIP logs live in the **Matter Server add-on**
(a separate container), not in Home Assistant Core's Python logging. So when
running under Supervisor we follow the add-on's logs over the Supervisor API and
forward them to the panel. As a supplement/fallback (e.g. Container or Core
installs without Supervisor) we also attach a handler to the in-process
``matter_server`` / ``chip`` client loggers.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import aiohttp
import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DOMAIN, STREAMED_LOGGERS

_REGISTERED = f"{DOMAIN}_ws_registered"

# Level we drop the in-process loggers to while a client is watching.
_STREAM_LEVEL = logging.INFO

# Candidate slugs for the official Matter Server add-on.
_ADDON_SLUGS = ("core_matter_server", "core_matter")


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the integration's websocket commands exactly once."""
    if hass.data.get(_REGISTERED):
        return
    hass.data[_REGISTERED] = True
    websocket_api.async_register_command(hass, ws_subscribe_logs)


def _log_event(msg_id: int, level: str, name: str, message: str) -> dict[str, Any]:
    return websocket_api.event_message(
        msg_id,
        {"level": level, "name": name, "message": message, "created": 0},
    )


def _guess_level(line: str) -> str:
    upper = line.upper()
    if "[ERROR]" in upper or " ERROR " in upper or "CRITICAL" in upper:
        return "ERROR"
    if "[WARNING]" in upper or " WARN" in upper:
        return "WARNING"
    if "[DEBUG]" in upper or " DEBUG " in upper:
        return "DEBUG"
    return "INFO"


class _StreamHandler(logging.Handler):
    """Forward in-process log records to a websocket connection, thread-safe."""

    def __init__(
        self,
        hass: HomeAssistant,
        connection: websocket_api.ActiveConnection,
        msg_id: int,
    ) -> None:
        super().__init__()
        self._hass = hass
        self._connection = connection
        self._msg_id = msg_id

    def emit(self, record: logging.LogRecord) -> None:
        # Records may originate from CHIP's native threads, so marshal the send
        # back onto the event loop.
        try:
            payload = {
                "level": record.levelname,
                "name": record.name,
                "message": record.getMessage(),
                "created": record.created,
            }
        except Exception:  # noqa: BLE001 - a broken record must never crash logging
            return
        self._hass.loop.call_soon_threadsafe(self._safe_send, payload)

    def _safe_send(self, payload: dict[str, Any]) -> None:
        try:
            self._connection.send_message(
                websocket_api.event_message(self._msg_id, payload)
            )
        except Exception:  # noqa: BLE001 - connection may be closing
            pass


async def _follow_addon_logs(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg_id: int,
    token: str,
) -> None:
    """Follow the Matter Server add-on logs via the Supervisor API."""
    session = async_get_clientsession(hass)
    headers = {"Authorization": f"Bearer {token}", "Accept": "text/plain"}
    # No read timeout: this is a long-lived streaming request.
    timeout = aiohttp.ClientTimeout(total=None, connect=10, sock_read=None)
    # The Supervisor host is provided via env; default to the internal hostname.
    host = os.environ.get("SUPERVISOR", "supervisor")

    for slug in _ADDON_SLUGS:
        url = f"http://{host}/addons/{slug}/logs/follow"
        try:
            async with session.get(
                url, headers=headers, params={"lines": 30}, timeout=timeout
            ) as resp:
                if resp.status != 200:
                    connection.send_message(
                        _log_event(
                            msg_id,
                            "DEBUG",
                            DOMAIN,
                            f"add-on '{slug}' logs → HTTP {resp.status} (trying next)…",
                        )
                    )
                    continue
                connection.send_message(
                    _log_event(
                        msg_id, "INFO", DOMAIN, f"Streaming Matter Server add-on logs ({slug})…"
                    )
                )
                async for raw in resp.content:
                    line = raw.decode("utf-8", "replace").rstrip("\r\n")
                    if line:
                        connection.send_message(
                            _log_event(msg_id, _guess_level(line), "matter-server", line)
                        )
            return
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001 - try the next slug / fall through
            connection.send_message(
                _log_event(
                    msg_id, "DEBUG", DOMAIN, f"add-on '{slug}' logs failed: {err} (trying next)…"
                )
            )
            continue

    connection.send_message(
        _log_event(
            msg_id,
            "WARNING",
            DOMAIN,
            "Could not attach to the Matter Server add-on logs "
            f"(host '{host}', slugs tried: {', '.join(_ADDON_SLUGS)}). "
            "Showing Home Assistant's in-process Matter client logs only. "
            "If your add-on uses a different slug, set it in _ADDON_SLUGS.",
        )
    )


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/subscribe_logs"}
)
@websocket_api.require_admin
@callback
def ws_subscribe_logs(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Stream Matter Server logs until the client unsubscribes."""
    msg_id = msg["id"]

    # 1) In-process client loggers (always available).
    handler = _StreamHandler(hass, connection, msg_id)
    handler.setLevel(logging.NOTSET)
    restore: list[tuple[logging.Logger, int]] = []
    for name in STREAMED_LOGGERS:
        logger = logging.getLogger(name)
        restore.append((logger, logger.level))
        if logger.level == logging.NOTSET or logger.level > _STREAM_LEVEL:
            logger.setLevel(_STREAM_LEVEL)
        logger.addHandler(handler)

    # 2) Matter Server add-on logs via Supervisor (the detailed ones), if present.
    task: asyncio.Task | None = None
    token = os.environ.get("SUPERVISOR_TOKEN")

    @callback
    def _unsubscribe() -> None:
        for logger, original_level in restore:
            logger.removeHandler(handler)
            logger.setLevel(original_level)
        if task and not task.done():
            task.cancel()

    connection.subscriptions[msg_id] = _unsubscribe
    connection.send_result(msg_id)
    connection.send_message(
        _log_event(
            msg_id,
            "INFO",
            DOMAIN,
            f"Log stream connected (in-process loggers: {', '.join(STREAMED_LOGGERS)}).",
        )
    )

    if token:
        connection.send_message(
            _log_event(msg_id, "INFO", DOMAIN, "Supervisor detected — attaching to add-on logs…")
        )
        task = hass.async_create_background_task(
            _follow_addon_logs(hass, connection, msg_id, token),
            name=f"{DOMAIN}_addon_logs_{msg_id}",
        )
    else:
        connection.send_message(
            _log_event(
                msg_id,
                "WARNING",
                DOMAIN,
                "No SUPERVISOR_TOKEN in Home Assistant Core — cannot read the Matter "
                "Server add-on logs (Container/Core install, or HA not running under "
                "Supervisor). Showing in-process Matter client logs only.",
            )
        )
