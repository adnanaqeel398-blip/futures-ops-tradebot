"""
UI Vision Module
================
Uses OpenAI GPT-4o-mini to detect UI elements from a screenshot.
Returns structured element data (label, x, y, type).
"""

import base64
import json
import logging

import cv2
from openai import OpenAI

import config

logger = logging.getLogger(__name__)

_client = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=config.OPENAI_API_KEY)
    return _client


DETECTION_PROMPT = (
    "Analyze this screenshot and detect all interactive UI elements "
    "(buttons, links, input fields, menus, icons). "
    "Return a JSON object with an 'elements' array. Each element must have: "
    '"label" (text/description), "type" (button/link/input/icon/menu), '
    '"x" (center x pixel), "y" (center y pixel), '
    '"confidence" (0.0 to 1.0). '
    "Return ONLY valid JSON, no markdown fences."
)


def detect_ui(frame) -> dict:
    """
    Send a screenshot frame to GPT-4o-mini for UI element detection.

    Parameters
    ----------
    frame : numpy.ndarray
        BGR image from OpenCV / mss.

    Returns
    -------
    dict
        {"elements": [{"label": ..., "type": ..., "x": ..., "y": ..., "confidence": ...}, ...]}
    """
    client = _get_client()

    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    img_b64 = base64.b64encode(buf).decode()

    try:
        res = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": DETECTION_PROMPT},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{img_b64}"
                            },
                        },
                    ],
                }
            ],
            max_tokens=1024,
        )

        raw = res.choices[0].message.content.strip()
        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1]
            raw = raw.rsplit("```", 1)[0]

        data = json.loads(raw)
        if "elements" not in data:
            data = {"elements": []}
        logger.info("Detected %d UI elements", len(data["elements"]))
        return data

    except json.JSONDecodeError as e:
        logger.error("Failed to parse UI detection response: %s", e)
        return {"elements": []}
    except Exception as e:
        logger.error("UI detection API error: %s", e)
        return {"elements": []}
