"""
Local Server
=============
Flask API server for the Jarvis dashboard.
Provides endpoints for running goals, checking status,
viewing memory, and RL stats.
"""

import logging

from flask import Flask, request, jsonify
from flask_cors import CORS

from controller import run_goal, get_state, clear_logs
from ui_memory import stats as memory_stats, clear as memory_clear
from rl_agent import get_stats as rl_stats
from voice import speak, listen

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)  # Allow dashboard to connect from file:// or other origins


@app.route("/run", methods=["POST"])
def handle_run():
    """Execute a goal."""
    data = request.get_json(silent=True)
    if not data or "goal" not in data:
        return jsonify({"error": "Missing 'goal' in request body"}), 400

    goal = data["goal"].strip()
    if not goal:
        return jsonify({"error": "Goal cannot be empty"}), 400

    result = run_goal(goal)
    return jsonify(result)


@app.route("/status")
def handle_status():
    """Return current bot state and stats."""
    state = get_state()
    return jsonify({
        "status": "running",
        "logs": state["logs"][-20:],  # last 20 logs
        "goals_completed": state["goals_completed"],
        "goals_failed": state["goals_failed"],
        "goals_blocked": state["goals_blocked"],
        "last_action": state["last_action"],
        "started_at": state["started_at"],
    })


@app.route("/memory")
def handle_memory():
    """Return memory statistics."""
    return jsonify(memory_stats())


@app.route("/memory/clear", methods=["POST"])
def handle_memory_clear():
    """Clear UI memory."""
    memory_clear()
    return jsonify({"status": "memory_cleared"})


@app.route("/rl")
def handle_rl():
    """Return RL agent statistics."""
    return jsonify(rl_stats())


@app.route("/logs/clear", methods=["POST"])
def handle_logs_clear():
    """Clear action logs."""
    clear_logs()
    return jsonify({"status": "logs_cleared"})


@app.route("/voice/speak", methods=["POST"])
def handle_speak():
    """Speak text aloud using TTS."""
    data = request.get_json(silent=True)
    if not data or "text" not in data:
        return jsonify({"error": "Missing 'text' in request body"}), 400

    text = data["text"].strip()
    if not text:
        return jsonify({"error": "Text cannot be empty"}), 400

    engine = speak(text)
    return jsonify({"status": "ok", "engine": engine, "text": text})


@app.route("/voice/listen", methods=["POST"])
def handle_listen():
    """Listen to microphone and return transcribed text."""
    data = request.get_json(silent=True) or {}
    timeout = data.get("timeout", 5)
    phrase_limit = data.get("phrase_limit", 10)

    result = listen(timeout=timeout, phrase_limit=phrase_limit)
    return jsonify(result)


@app.route("/voice/run", methods=["POST"])
def handle_voice_run():
    """Listen → execute goal → speak result. Full voice interaction."""
    data = request.get_json(silent=True) or {}
    timeout = data.get("timeout", 5)

    # Step 1: Listen
    heard = listen(timeout=timeout)
    if heard["status"] != "ok" or not heard["text"]:
        return jsonify({
            "status": "no_input",
            "listen_result": heard,
        })

    goal = heard["text"]

    # Step 2: Execute
    result = run_goal(goal)

    # Step 3: Speak result
    status = result.get("status", "unknown")
    if status == "blocked":
        response = f"Blocked for safety: {result.get('reason', 'unsafe')}"
    elif status == "error":
        response = f"Error: {result.get('error', 'unknown')}"
    else:
        response = f"Done. {result.get('result', 'completed')}"

    speak(response)

    return jsonify({
        "status": "ok",
        "heard": goal,
        "result": result,
        "spoken": response,
    })


@app.route("/health")
def handle_health():
    """Health check endpoint."""
    return jsonify({"status": "ok", "service": "jarvis-local"})


if __name__ == "__main__":
    logger.info("Starting Jarvis Local Server on port 5050...")
    app.run(host="0.0.0.0", port=5050, debug=False)
