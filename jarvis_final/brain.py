"""
Brain Module
============
The central AI reasoning engine. Uses OpenAI to interpret user goals,
break them into steps, and coordinate with other modules.
"""

import json
import logging

from openai import OpenAI

import config

logger = logging.getLogger(__name__)

_client = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        _client = OpenAI(api_key=config.OPENAI_API_KEY)
    return _client


SYSTEM_PROMPT = """You are Jarvis, an AI desktop assistant. You help the user by:
1. Understanding their goal in natural language.
2. Breaking it into concrete steps.
3. Choosing the right actions (click, type, search, navigate, scroll, wait).

Respond with a JSON object:
{
  "understanding": "what the user wants",
  "steps": [
    {"action": "click|type|search|navigate|scroll|hotkey|wait", "target": "what to act on", "value": "optional value"}
  ],
  "confidence": 0.0 to 1.0
}

Available actions:
- click: click on a UI element (target = element description)
- type: type text (target = input field, value = text to type)
- search: search for something (value = search query)
- navigate: go to a URL (value = URL)
- scroll: scroll the page (value = "up" or "down")
- hotkey: press keyboard shortcut (value = "ctrl+c", "alt+tab", etc.)
- wait: wait for page/element to load (value = seconds)

Return ONLY valid JSON, no markdown fences."""


def think(goal: str, context: str = "") -> dict:
    """
    Process a natural language goal and return a structured plan.

    Parameters
    ----------
    goal : str
        The user's goal in natural language.
    context : str
        Optional context about current screen state.

    Returns
    -------
    dict
        Structured plan with steps to execute.
    """
    client = _get_client()

    user_message = f"Goal: {goal}"
    if context:
        user_message += f"\nCurrent context: {context}"

    try:
        res = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_message},
            ],
            max_tokens=512,
            temperature=0.3,
        )

        raw = res.choices[0].message.content.strip()
        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1]
            raw = raw.rsplit("```", 1)[0]

        plan = json.loads(raw)
        logger.info("Brain produced plan with %d steps (confidence=%.2f)",
                     len(plan.get("steps", [])), plan.get("confidence", 0))
        return plan

    except json.JSONDecodeError as e:
        logger.error("Failed to parse brain response: %s", e)
        return {
            "understanding": goal,
            "steps": [{"action": "click", "target": goal, "value": ""}],
            "confidence": 0.3,
        }
    except Exception as e:
        logger.error("Brain API error: %s", e)
        return {
            "understanding": goal,
            "steps": [],
            "confidence": 0.0,
            "error": str(e),
        }


def summarize_state(logs: list[str]) -> str:
    """
    Summarize recent actions for context.
    """
    if not logs:
        return "No recent actions."
    recent = logs[-5:]  # last 5 actions
    return " | ".join(recent)
