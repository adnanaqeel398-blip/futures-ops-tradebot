"""
Safety Module
=============
Checks commands against blocked keywords and patterns.
Provides approval workflows for dangerous operations.
"""

import logging
import re

import config

logger = logging.getLogger(__name__)

# Additional dangerous patterns (regex)
DANGEROUS_PATTERNS = [
    r"rm\s+-rf\s+/",
    r"mkfs\.",
    r"dd\s+if=",
    r":(){ :|:& };:",  # fork bomb
    r">\s*/dev/sd",
    r"chmod\s+-R\s+777\s+/",
]


def check(text: str) -> bool:
    """
    Check if a command/goal is safe to execute.

    Parameters
    ----------
    text : str
        The command or goal text to check.

    Returns
    -------
    bool
        True if safe, False if blocked.
    """
    if not config.SAFE_MODE:
        return True

    text_lower = text.lower().strip()

    # Check blocked keywords
    for keyword in config.BLOCKED_KEYWORDS:
        if keyword in text_lower:
            logger.warning("BLOCKED: '%s' contains blocked keyword '%s'", text, keyword)
            return False

    # Check dangerous regex patterns
    for pattern in DANGEROUS_PATTERNS:
        if re.search(pattern, text_lower):
            logger.warning("BLOCKED: '%s' matches dangerous pattern '%s'", text, pattern)
            return False

    return True


def requires_approval(text: str) -> bool:
    """
    Check if a command needs explicit user approval before execution.
    Less dangerous than blocked commands but still sensitive.
    """
    sensitive_keywords = [
        "install", "download", "execute", "sudo",
        "admin", "root", "password", "credential",
    ]
    text_lower = text.lower()
    return any(kw in text_lower for kw in sensitive_keywords)


def sanitize(text: str) -> str:
    """
    Remove or escape potentially dangerous characters from input.
    """
    # Remove shell special characters
    dangerous_chars = [";", "|", "&", "`", "$", "(", ")", "{", "}", "<", ">"]
    sanitized = text
    for char in dangerous_chars:
        sanitized = sanitized.replace(char, "")
    return sanitized.strip()


def get_safety_report(text: str) -> dict:
    """
    Generate a safety report for a command.
    """
    return {
        "text": text,
        "is_safe": check(text),
        "needs_approval": requires_approval(text),
        "sanitized": sanitize(text),
    }
