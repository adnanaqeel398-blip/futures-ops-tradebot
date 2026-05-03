"""
RL Agent Module
===============
Simple Q-learning agent that learns which actions work best
for different states/goals over time.
"""

import json
import logging
import os
import random

import config

logger = logging.getLogger(__name__)

ACTIONS = [
    "search",
    "login",
    "click",
    "scroll",
    "type",
    "wait",
    "screenshot",
    "navigate",
]

Q_FILE = os.path.join(os.path.dirname(__file__), "q_table.json")

# Q-table: {state: {action: value}}
Q: dict[str, dict[str, float]] = {}


def _load_q_table() -> None:
    """Load Q-table from disk if it exists."""
    global Q
    if os.path.exists(Q_FILE):
        try:
            with open(Q_FILE, "r") as f:
                Q = json.load(f)
            logger.info("Loaded Q-table with %d states", len(Q))
        except (json.JSONDecodeError, IOError):
            Q = {}


def _save_q_table() -> None:
    """Persist Q-table to disk."""
    with open(Q_FILE, "w") as f:
        json.dump(Q, f, indent=2)


def choose(state: str) -> str:
    """
    Choose the best action for a given state using epsilon-greedy.

    Parameters
    ----------
    state : str
        Current state description (e.g., "login_page", "search_results").

    Returns
    -------
    str
        The chosen action.
    """
    if state not in Q:
        Q[state] = {a: 0.0 for a in ACTIONS}

    # Epsilon-greedy exploration
    if random.random() < config.RL_EPSILON:
        action = random.choice(ACTIONS)
        logger.info("RL explore: state='%s' -> action='%s'", state, action)
    else:
        action = max(Q[state], key=Q[state].get)
        logger.info("RL exploit: state='%s' -> action='%s' (Q=%.2f)", state, action, Q[state][action])

    return action


def update(state: str, action: str, reward: float, next_state: str) -> None:
    """
    Update Q-value using the Q-learning formula.

    Parameters
    ----------
    state : str
        The state before the action.
    action : str
        The action taken.
    reward : float
        The reward received.
    next_state : str
        The resulting state.
    """
    if state not in Q:
        Q[state] = {a: 0.0 for a in ACTIONS}
    if next_state not in Q:
        Q[next_state] = {a: 0.0 for a in ACTIONS}

    old_value = Q[state][action]
    next_max = max(Q[next_state].values())

    # Q-learning update rule
    Q[state][action] = old_value + config.RL_ALPHA * (
        reward + config.RL_GAMMA * next_max - old_value
    )

    logger.info(
        "RL update: Q[%s][%s] %.2f -> %.2f (reward=%.1f)",
        state, action, old_value, Q[state][action], reward,
    )

    _save_q_table()


def get_stats() -> dict:
    """Return RL agent statistics."""
    return {
        "states": len(Q),
        "total_entries": sum(len(v) for v in Q.values()),
        "q_table_preview": {
            k: {a: round(v, 2) for a, v in actions.items() if v != 0}
            for k, actions in list(Q.items())[:5]
        },
    }


# Load Q-table on module import
_load_q_table()
