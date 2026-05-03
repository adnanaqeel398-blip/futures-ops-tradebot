"""
Jarvis Bot Configuration
========================
Central configuration for all modules.
Set your OpenAI API key via environment variable OPENAI_API_KEY
or replace the default below.
"""

import os

# --- API Keys ---
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "YOUR_KEY")

# --- Safety ---
SAFE_MODE = True
BLOCKED_KEYWORDS = ["delete", "format", "shutdown", "rm -rf", "drop table"]

# --- Vision / UI ---
CLICK_CONFIDENCE = 0.6
SCREEN_MONITOR = 1  # mss monitor index (1 = primary)

# --- Networking ---
TOKEN = os.environ.get("JARVIS_TOKEN", "jarvis_token")
SERVER_URL = "http://127.0.0.1:5050"
CLOUD_SERVER_URL = "http://127.0.0.1:8000"

# --- RL Agent ---
RL_EPSILON = 0.1       # exploration rate
RL_ALPHA = 0.1         # learning rate
RL_GAMMA = 0.9         # discount factor

# --- Memory ---
MEMORY_FILE = os.path.join(os.path.dirname(__file__), "memory.json")

# --- Logging ---
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO")
