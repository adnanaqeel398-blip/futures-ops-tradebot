"""
Agent Client
=============
Polls the cloud server for commands and executes them locally.
Runs as a persistent background process.
"""

import logging
import time
import signal
import sys

import requests

import config
from controller import run_goal

logging.basicConfig(level=logging.INFO, format="%(asctime)s [agent] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

POLL_INTERVAL = 2  # seconds
MAX_RETRIES = 5
RETRY_BACKOFF = 5  # seconds

_running = True


def _signal_handler(sig, frame):
    """Handle graceful shutdown."""
    global _running
    logger.info("Shutting down agent client...")
    _running = False


signal.signal(signal.SIGINT, _signal_handler)
signal.signal(signal.SIGTERM, _signal_handler)


def poll_and_execute():
    """Main loop: poll cloud server and execute commands."""
    consecutive_errors = 0

    logger.info("Agent client started. Polling %s every %ds", config.CLOUD_SERVER_URL, POLL_INTERVAL)

    while _running:
        try:
            url = f"{config.CLOUD_SERVER_URL}/fetch"
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            if data.get("cmd"):
                cmd = data["cmd"]
                logger.info("Received command: '%s'", cmd)

                result = run_goal(cmd)
                logger.info("Command result: %s", result.get("status", "unknown"))

                # Report result back to cloud (optional)
                try:
                    requests.post(
                        f"{config.CLOUD_SERVER_URL}/command",
                        json={
                            "command": f"RESULT: {cmd} -> {result.get('status', 'unknown')}",
                            "priority": "low",
                        },
                        timeout=5,
                    )
                except Exception:
                    pass  # Result reporting is non-critical

                consecutive_errors = 0
            else:
                consecutive_errors = 0

        except requests.ConnectionError:
            consecutive_errors += 1
            if consecutive_errors <= 3:
                logger.warning("Cannot reach cloud server (attempt %d/%d)", consecutive_errors, MAX_RETRIES)
            if consecutive_errors >= MAX_RETRIES:
                logger.error("Cloud server unreachable after %d attempts. Backing off...", MAX_RETRIES)
                time.sleep(RETRY_BACKOFF * 2)
                consecutive_errors = 0
                continue

        except requests.RequestException as e:
            logger.error("Request error: %s", e)
            consecutive_errors += 1

        except Exception as e:
            logger.error("Unexpected error: %s", e)
            consecutive_errors += 1

        sleep_time = POLL_INTERVAL + (RETRY_BACKOFF if consecutive_errors > 0 else 0)
        time.sleep(sleep_time)

    logger.info("Agent client stopped.")


if __name__ == "__main__":
    poll_and_execute()
