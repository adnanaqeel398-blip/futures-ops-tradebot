"""
UI Memory Module
================
Persistent JSON-based memory for UI element locations.
Allows the bot to remember where buttons/elements are
so it doesn't need vision every time.
"""

import json
import logging
import os
import threading

import config

logger = logging.getLogger(__name__)

_lock = threading.Lock()


def _get_path() -> str:
    return config.MEMORY_FILE


def load() -> dict:
    """Load memory from disk."""
    path = _get_path()
    with _lock:
        if not os.path.exists(path):
            return {"ui": {}, "interactions": 0}
        try:
            with open(path, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            logger.warning("Corrupted memory file, resetting: %s", e)
            return {"ui": {}, "interactions": 0}


def save(data: dict) -> None:
    """Save memory to disk."""
    path = _get_path()
    with _lock:
        with open(path, "w") as f:
            json.dump(data, f, indent=2)


def find(intent: str, app: str = "default") -> dict | None:
    """
    Find a remembered UI element matching the intent for a given app.

    Parameters
    ----------
    intent : str
        What the user wants to click (e.g. "search", "login").
    app : str
        Application context (e.g. "chrome", "vscode").

    Returns
    -------
    dict or None
        Element dict with label, x, y, etc. or None if not found.
    """
    data = load()
    elements = data.get("ui", {}).get(app, [])
    intent_lower = intent.lower()

    for el in elements:
        if intent_lower in el.get("label", "").lower():
            logger.info("Memory hit: '%s' in app '%s' -> %s", intent, app, el)
            return el

    return None


def store(app: str, element: dict) -> None:
    """
    Store a UI element in memory for future use.

    Parameters
    ----------
    app : str
        Application context.
    element : dict
        Element data (must include label, x, y).
    """
    data = load()
    data.setdefault("ui", {}).setdefault(app, [])

    # Avoid duplicates by label
    existing_labels = {e.get("label", "").lower() for e in data["ui"][app]}
    if element.get("label", "").lower() not in existing_labels:
        data["ui"][app].append(element)
        logger.info("Stored new element for app '%s': %s", app, element.get("label"))
    else:
        # Update position of existing element
        for i, e in enumerate(data["ui"][app]):
            if e.get("label", "").lower() == element.get("label", "").lower():
                data["ui"][app][i] = element
                logger.info("Updated element for app '%s': %s", app, element.get("label"))
                break

    data["interactions"] = data.get("interactions", 0) + 1
    save(data)


def clear(app: str | None = None) -> None:
    """Clear memory for a specific app or all apps."""
    data = load()
    if app:
        data.get("ui", {}).pop(app, None)
    else:
        data["ui"] = {}
    save(data)


def stats() -> dict:
    """Return memory statistics."""
    data = load()
    return {
        "apps": list(data.get("ui", {}).keys()),
        "total_elements": sum(
            len(els) for els in data.get("ui", {}).values()
        ),
        "interactions": data.get("interactions", 0),
    }
