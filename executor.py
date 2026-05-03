"""
Executor Module
===============
Handles smart clicking with memory-first approach.
Falls back to vision-based detection when memory has no match.
"""

import logging
import sys
import types

# Monkey-patch mouseinfo before pyautogui import (requires tkinter which
# may not be available in headless / pyenv environments).
if "mouseinfo" not in sys.modules:
    _mi = types.ModuleType("mouseinfo")
    _mi.MouseInfoWindow = None  # type: ignore[attr-defined]
    sys.modules["mouseinfo"] = _mi

import pyautogui  # noqa: E402

import config
from ui_memory import find, store
from ui_vision import detect_ui
from vision import capture_screen

logger = logging.getLogger(__name__)

# Safety: prevent pyautogui from moving to corners (failsafe)
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.3


def smart_click(intent: str, app: str = "chrome") -> str:
    """
    Click a UI element matching the intent.

    Strategy:
    1. Check memory for a known element location.
    2. If not found, capture screen and use vision AI to detect elements.
    3. Click the best match and store it in memory.

    Parameters
    ----------
    intent : str
        What to click (e.g., "search", "login button").
    app : str
        Application context for memory lookup.

    Returns
    -------
    str
        Result: "memory_click", "vision_click", or "not_found".
    """
    # Step 1: Try memory
    el = find(intent, app)
    if el:
        x, y = el.get("x", 0), el.get("y", 0)
        logger.info("Memory click: '%s' at (%d, %d)", intent, x, y)
        pyautogui.click(x, y)
        return "memory_click"

    # Step 2: Vision-based detection
    logger.info("No memory for '%s', using vision...", intent)
    frame = capture_screen()
    ui_data = detect_ui(frame)

    intent_lower = intent.lower()
    best_match = None
    best_confidence = 0.0

    for element in ui_data.get("elements", []):
        label = element.get("label", "").lower()
        confidence = element.get("confidence", 0.0)

        if intent_lower in label and confidence >= config.CLICK_CONFIDENCE:
            if confidence > best_confidence:
                best_match = element
                best_confidence = confidence

    if best_match:
        x = best_match.get("x", 500)
        y = best_match.get("y", 500)
        logger.info(
            "Vision click: '%s' at (%d, %d) confidence=%.2f",
            intent, x, y, best_confidence,
        )
        pyautogui.click(x, y)
        store(app, best_match)
        return "vision_click"

    logger.warning("Element not found for intent: '%s'", intent)
    return "not_found"


def type_text(text: str, interval: float = 0.02) -> None:
    """Type text using pyautogui."""
    pyautogui.typewrite(text, interval=interval)
    logger.info("Typed text: '%s...'", text[:30])


def hotkey(*keys: str) -> None:
    """Press a keyboard shortcut."""
    pyautogui.hotkey(*keys)
    logger.info("Hotkey: %s", "+".join(keys))


def move_to(x: int, y: int) -> None:
    """Move the mouse cursor to a position."""
    pyautogui.moveTo(x, y)


def scroll_screen(clicks: int = -3) -> None:
    """Scroll the screen. Negative = down, positive = up."""
    pyautogui.scroll(clicks)
    logger.info("Scrolled %d clicks", clicks)
