"""
Controller Module
=================
Central coordinator that ties together brain, council, safety, and RL.
Manages state and execution flow.
"""

import logging
from datetime import datetime, timezone

import safety
from brain import think, summarize_state
from council import run as council_run

logger = logging.getLogger(__name__)

# Global state
STATE = {
    "logs": [],
    "goals_completed": 0,
    "goals_failed": 0,
    "goals_blocked": 0,
    "last_action": None,
    "started_at": datetime.now(timezone.utc).isoformat(),
}

MAX_LOG_SIZE = 200


def run_goal(goal: str) -> dict:
    """
    Execute a goal through the full pipeline:
    1. Safety check
    2. Brain analysis (if API key is set)
    3. Council execution

    Parameters
    ----------
    goal : str
        Natural language goal from the user.

    Returns
    -------
    dict
        Result with status, action taken, and details.
    """
    timestamp = datetime.now(timezone.utc).isoformat()

    # Step 1: Safety check
    if not safety.check(goal):
        msg = f"[{timestamp}] BLOCKED: '{goal}' - unsafe command"
        STATE["logs"].append(msg)
        STATE["goals_blocked"] += 1
        logger.warning(msg)
        return {"status": "blocked", "reason": "unsafe_command", "goal": goal}

    # Step 2: Check if approval needed
    if safety.requires_approval(goal):
        logger.info("Goal '%s' requires approval", goal)
        # In a full system, this would pause and wait for user approval
        # For now, we log it and proceed
        STATE["logs"].append(f"[{timestamp}] APPROVAL_NEEDED: '{goal}'")

    # Step 3: Brain analysis (optional, requires valid API key)
    plan = None
    try:
        context = summarize_state(STATE["logs"])
        plan = think(goal, context)
    except Exception as e:
        logger.info("Brain skipped (API may not be configured): %s", e)

    # Step 4: Council execution
    try:
        result = council_run(goal)
        msg = f"[{timestamp}] {goal} -> {result}"
        STATE["logs"].append(msg)
        STATE["goals_completed"] += 1
        STATE["last_action"] = {
            "goal": goal,
            "result": result,
            "plan": plan,
            "timestamp": timestamp,
        }
        logger.info(msg)

        # Trim logs if too large
        if len(STATE["logs"]) > MAX_LOG_SIZE:
            STATE["logs"] = STATE["logs"][-MAX_LOG_SIZE:]

        return {
            "status": "completed",
            "goal": goal,
            "result": result,
            "plan": plan,
        }

    except Exception as e:
        msg = f"[{timestamp}] FAILED: '{goal}' - {e}"
        STATE["logs"].append(msg)
        STATE["goals_failed"] += 1
        logger.error(msg)
        return {"status": "error", "goal": goal, "error": str(e)}


def get_state() -> dict:
    """Return current bot state."""
    return STATE


def clear_logs() -> None:
    """Clear the log history."""
    STATE["logs"].clear()
