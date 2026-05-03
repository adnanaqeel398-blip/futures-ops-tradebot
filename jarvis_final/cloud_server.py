"""
Cloud Server
=============
Remote command queue server. Allows sending commands to
Jarvis agents from anywhere. Agents poll for new commands.
"""

import logging
import threading
from datetime import datetime, timezone

from flask import Flask, request, jsonify
from flask_cors import CORS

import config

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# Thread-safe command queue
_lock = threading.Lock()
QUEUE: list[dict] = []
HISTORY: list[dict] = []
MAX_HISTORY = 100


@app.route("/command", methods=["POST"])
def handle_command():
    """Add a command to the queue."""
    data = request.get_json(silent=True)
    if not data or "command" not in data:
        return jsonify({"error": "Missing 'command' in request body"}), 400

    # Optional auth token check
    token = request.headers.get("Authorization", "")
    if config.TOKEN and token != f"Bearer {config.TOKEN}":
        logger.warning("Unauthorized command attempt")
        # Allow without token for local dev, but log it
        pass

    cmd_entry = {
        "command": data["command"],
        "priority": data.get("priority", "normal"),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": request.remote_addr,
    }

    with _lock:
        # Insert high-priority commands at the front
        if cmd_entry["priority"] == "high":
            QUEUE.insert(0, cmd_entry)
        else:
            QUEUE.append(cmd_entry)

    logger.info("Queued command: '%s' (priority=%s)", data["command"], cmd_entry["priority"])
    return jsonify({"status": "queued", "queue_size": len(QUEUE)})


@app.route("/fetch")
def handle_fetch():
    """Fetch the next command from the queue (FIFO)."""
    with _lock:
        if QUEUE:
            cmd = QUEUE.pop(0)
            # Add to history
            cmd["fetched_at"] = datetime.now(timezone.utc).isoformat()
            HISTORY.append(cmd)
            if len(HISTORY) > MAX_HISTORY:
                HISTORY.pop(0)

            logger.info("Dispatched command: '%s'", cmd["command"])
            return jsonify({"cmd": cmd["command"], "meta": cmd})

    return jsonify({"cmd": None})


@app.route("/queue")
def handle_queue():
    """View the current command queue."""
    return jsonify({"queue": QUEUE, "size": len(QUEUE)})


@app.route("/history")
def handle_history():
    """View command history."""
    return jsonify({"history": HISTORY[-20:], "total": len(HISTORY)})


@app.route("/health")
def handle_health():
    """Health check."""
    return jsonify({"status": "ok", "service": "jarvis-cloud"})


if __name__ == "__main__":
    logger.info("Starting Jarvis Cloud Server on port 8000...")
    app.run(host="0.0.0.0", port=8000, debug=False)
