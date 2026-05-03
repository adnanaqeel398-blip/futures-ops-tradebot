"""
Vision Module
=============
Screen capture utilities using mss (cross-platform).
"""

import logging

import cv2
import mss
import numpy as np

import config

logger = logging.getLogger(__name__)


def capture_screen(monitor_index: int | None = None) -> np.ndarray:
    """Capture the screen and return a BGR numpy array."""
    idx = monitor_index or config.SCREEN_MONITOR
    with mss.mss() as sct:
        monitors = sct.monitors
        if idx >= len(monitors):
            logger.warning("Monitor %d not found, falling back to 1", idx)
            idx = 1
        img = np.array(sct.grab(monitors[idx]))
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)


def capture_region(x: int, y: int, w: int, h: int) -> np.ndarray:
    """Capture a specific region of the screen."""
    with mss.mss() as sct:
        region = {"left": x, "top": y, "width": w, "height": h}
        img = np.array(sct.grab(region))
        return cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)


def save_screenshot(path: str = "screenshot.png") -> str:
    """Capture screen and save to disk. Returns the file path."""
    frame = capture_screen()
    cv2.imwrite(path, frame)
    logger.info("Screenshot saved to %s", path)
    return path
