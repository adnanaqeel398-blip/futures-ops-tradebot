"""
Jarvis Bot - Main Entry Point
==============================
Starts all services and provides a CLI interface.

Usage:
    python main.py                  # Start local server + CLI
    python main.py --server         # Start local server only
    python main.py --cloud          # Start cloud server only
    python main.py --agent          # Start agent client only
    python main.py --all            # Start everything
    python main.py --cli            # CLI mode only (no server)
    python main.py --voice          # Voice mode (listen + speak)
"""

import argparse
import logging
import sys
import threading
import time

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("jarvis")


def start_local_server():
    """Start the local Flask server in a thread."""
    from server import app
    logger.info("Starting local server on port 5050...")
    app.run(host="0.0.0.0", port=5050, debug=False, use_reloader=False)


def start_cloud_server():
    """Start the cloud server in a thread."""
    from cloud_server import app
    logger.info("Starting cloud server on port 8000...")
    app.run(host="0.0.0.0", port=8000, debug=False, use_reloader=False)


def start_agent_client():
    """Start the agent client in a thread."""
    from agent_client import poll_and_execute
    logger.info("Starting agent client...")
    poll_and_execute()


def run_cli():
    """Interactive CLI for sending goals to Jarvis."""
    from controller import run_goal, get_state

    print("\n" + "=" * 50)
    print("  JARVIS BOT - Interactive CLI")
    print("=" * 50)
    print("Commands:")
    print("  Type a goal    -> Execute it")
    print("  /status        -> Show bot status")
    print("  /logs          -> Show recent logs")
    print("  /clear         -> Clear logs")
    print("  /voice         -> Switch to voice mode")
    print("  /help          -> Show this help")
    print("  /quit          -> Exit")
    print("=" * 50 + "\n")

    while True:
        try:
            user_input = input("jarvis> ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nGoodbye!")
            break

        if not user_input:
            continue

        if user_input == "/quit":
            print("Goodbye!")
            break

        if user_input == "/status":
            state = get_state()
            print(f"\n  Completed: {state['goals_completed']}")
            print(f"  Failed:    {state['goals_failed']}")
            print(f"  Blocked:   {state['goals_blocked']}")
            print(f"  Started:   {state['started_at']}")
            if state['last_action']:
                print(f"  Last:      {state['last_action']['goal']} -> {state['last_action']['result']}")
            print()
            continue

        if user_input == "/logs":
            state = get_state()
            logs = state["logs"][-10:]
            if not logs:
                print("  No logs yet.\n")
            else:
                print()
                for log in logs:
                    print(f"  {log}")
                print()
            continue

        if user_input == "/clear":
            from controller import clear_logs
            clear_logs()
            print("  Logs cleared.\n")
            continue

        if user_input == "/voice":
            try:
                from voice import voice_loop
                voice_loop()
            except ImportError:
                print("  Voice module not available. Install: pip install SpeechRecognition pyttsx3 gTTS PyAudio\n")
            except Exception as e:
                print(f"  Voice error: {e}\n")
            continue

        if user_input == "/help":
            print("\nCommands: /status, /logs, /clear, /voice, /quit")
            print("Or type any goal to execute it.\n")
            continue

        # Execute the goal
        result = run_goal(user_input)
        status = result.get("status", "unknown")
        if status == "blocked":
            print(f"  [BLOCKED] {result.get('reason', 'unsafe command')}\n")
        elif status == "error":
            print(f"  [ERROR] {result.get('error', 'unknown error')}\n")
        else:
            print(f"  [OK] {result.get('result', 'done')}\n")


def main():
    parser = argparse.ArgumentParser(description="Jarvis Bot")
    parser.add_argument("--server", action="store_true", help="Start local server only")
    parser.add_argument("--cloud", action="store_true", help="Start cloud server only")
    parser.add_argument("--agent", action="store_true", help="Start agent client only")
    parser.add_argument("--all", action="store_true", help="Start all services")
    parser.add_argument("--cli", action="store_true", help="CLI mode only (no server)")
    parser.add_argument("--voice", action="store_true", help="Voice mode (listen + speak)")
    args = parser.parse_args()

    threads = []

    if args.server:
        start_local_server()
        return

    if args.cloud:
        start_cloud_server()
        return

    if args.agent:
        start_agent_client()
        return

    if args.cli:
        run_cli()
        return

    if args.voice:
        from voice import voice_loop
        voice_loop()
        return

    if args.all:
        # Start all services in threads
        t1 = threading.Thread(target=start_local_server, daemon=True)
        t2 = threading.Thread(target=start_cloud_server, daemon=True)
        t3 = threading.Thread(target=start_agent_client, daemon=True)
        threads.extend([t1, t2, t3])
        for t in threads:
            t.start()
        time.sleep(1)
        logger.info("All services started!")
        run_cli()
        return

    # Default: start local server + CLI
    t = threading.Thread(target=start_local_server, daemon=True)
    t.start()
    threads.append(t)
    time.sleep(1)
    logger.info("Local server started on port 5050")
    run_cli()


if __name__ == "__main__":
    main()
