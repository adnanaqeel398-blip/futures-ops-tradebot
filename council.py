"""
Council Module (Multi-Agent Decision Layer)
===========================================
Multiple "agents" vote on the best approach for a goal.
Each agent has a specialty and scores goals differently.
The council picks the action with the highest combined score.
"""

import logging

from executor import smart_click, type_text, hotkey, scroll_screen
from rl_agent import choose as rl_choose

logger = logging.getLogger(__name__)


# --- Agent Definitions ---

def _navigation_agent(goal: str) -> dict:
    """Agent specialized in navigation tasks."""
    score = 0.0
    action = "click"
    keywords = ["open", "go to", "navigate", "visit", "browse", "url"]

    for kw in keywords:
        if kw in goal.lower():
            score += 0.8
            break

    return {"agent": "navigation", "action": action, "score": score}


def _search_agent(goal: str) -> dict:
    """Agent specialized in search tasks."""
    score = 0.0
    action = "search"
    keywords = ["search", "find", "look up", "query", "google", "lookup"]

    for kw in keywords:
        if kw in goal.lower():
            score += 0.9
            break

    return {"agent": "search", "action": action, "score": score}


def _auth_agent(goal: str) -> dict:
    """Agent specialized in authentication tasks."""
    score = 0.0
    action = "login"
    keywords = ["login", "sign in", "authenticate", "log in", "password", "credentials"]

    for kw in keywords:
        if kw in goal.lower():
            score += 0.85
            break

    return {"agent": "auth", "action": action, "score": score}


def _interaction_agent(goal: str) -> dict:
    """Agent specialized in generic UI interactions."""
    score = 0.3  # baseline score as fallback
    action = "click"
    keywords = ["click", "press", "tap", "select", "choose", "toggle", "check"]

    for kw in keywords:
        if kw in goal.lower():
            score += 0.7
            break

    return {"agent": "interaction", "action": action, "score": score}


def _input_agent(goal: str) -> dict:
    """Agent specialized in typing / text input."""
    score = 0.0
    action = "type"
    keywords = ["type", "write", "enter", "input", "fill", "compose"]

    for kw in keywords:
        if kw in goal.lower():
            score += 0.85
            break

    return {"agent": "input", "action": action, "score": score}


# All council agents
AGENTS = [
    _navigation_agent,
    _search_agent,
    _auth_agent,
    _interaction_agent,
    _input_agent,
]


def deliberate(goal: str) -> dict:
    """
    All agents vote on the goal. Returns the winning vote.

    Returns
    -------
    dict
        {"agent": str, "action": str, "score": float}
    """
    votes = [agent(goal) for agent in AGENTS]
    votes.sort(key=lambda v: v["score"], reverse=True)

    logger.info("Council votes for '%s':", goal)
    for v in votes:
        logger.info("  %s: action=%s score=%.2f", v["agent"], v["action"], v["score"])

    return votes[0]


def run(goal: str) -> str:
    """
    Execute a goal using the council's decision.

    Parameters
    ----------
    goal : str
        Natural language goal (e.g., "search for python docs").

    Returns
    -------
    str
        Result of the execution.
    """
    decision = deliberate(goal)
    action = decision["action"]
    agent_name = decision["agent"]

    logger.info("Council decided: agent='%s' action='%s' for goal='%s'", agent_name, action, goal)

    if action == "search":
        return smart_click("search")

    if action == "login":
        return smart_click("login")

    if action == "type":
        # Extract text after common keywords
        text = goal
        for prefix in ["type ", "write ", "enter ", "input ", "fill "]:
            if goal.lower().startswith(prefix):
                text = goal[len(prefix):]
                break
        type_text(text)
        return "typed"

    if action == "click":
        # Try to extract what to click from the goal
        target = goal
        for prefix in ["click ", "press ", "tap ", "select ", "open ", "navigate to "]:
            if goal.lower().startswith(prefix):
                target = goal[len(prefix):]
                break
        return smart_click(target)

    # Fallback to RL agent decision
    rl_action = rl_choose(goal)
    logger.info("Falling back to RL agent: %s", rl_action)
    return f"rl_{rl_action}"
