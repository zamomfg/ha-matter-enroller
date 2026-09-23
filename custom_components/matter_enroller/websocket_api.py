"""WebSocket API for the Matter Enroller integration.

The Matter *commissioning* itself is performed with the command that Home
Assistant's built-in Matter integration already exposes (``matter/commission``),
so the frontend calls that directly. This module only adds what the built-in
integration does not provide: a live stream of the Matter Server / CHIP stack
logs so the user can watch a Thread device being commissioned in real time.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, STREAMED_LOGGERS

_REGISTERED = f"{DOMAIN}_ws_registered"

# Level we drop the streamed loggers to while a client is watching, so
# commissioning progress reaches our handler. INFO (not DEBUG) avoids flooding
# the panel with verbose CHIP native chatter.
_STREAM_LEVEL = logging.INFO


@callback
def async_register(hass: HomeAssistant) -> None:
    """Register the integration's websocket commands exactly once."""
    if hass.data.get(_REGISTERED):
        return
    hass.data[_REGISTERED] = True
    websocket_api.async_register_command(hass, ws_subscribe_logs)


class _StreamHandler(logging.Handler):
    """Forward log records to a websocket connection, thread-safe."""

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
            payload: dict[str, Any] = {
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
    """Stream Matter Server / CHIP log records until the client unsubscribes."""
    handler = _StreamHandler(hass, connection, msg["id"])
    handler.setLevel(logging.NOTSET)

    restore: list[tuple[logging.Logger, int]] = []
    for name in STREAMED_LOGGERS:
        logger = logging.getLogger(name)
        # Remember the original level so we can put it back on unsubscribe.
        restore.append((logger, logger.level))
        if logger.level == logging.NOTSET or logger.level > _STREAM_LEVEL:
            logger.setLevel(_STREAM_LEVEL)
        logger.addHandler(handler)

    @callback
    def _unsubscribe() -> None:
        for logger, original_level in restore:
            logger.removeHandler(handler)
            logger.setLevel(original_level)

    connection.subscriptions[msg["id"]] = _unsubscribe
    connection.send_result(msg["id"])
    # Prime the stream so the panel shows immediate feedback.
    connection.send_message(
        websocket_api.event_message(
            msg["id"],
            {
                "level": "INFO",
                "name": DOMAIN,
                "message": "Streaming Matter Server logs…",
                "created": 0,
            },
        )
    )
