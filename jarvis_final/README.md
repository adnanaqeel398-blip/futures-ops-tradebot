# Jarvis Bot

A multi-agent AI desktop assistant with vision, reinforcement learning, memory-based UI interaction, voice control, and remote control capabilities.

## Features

| Module | Description |
|--------|-------------|
| **Brain** | GPT-4o-mini powered reasoning engine that breaks goals into actionable steps |
| **Vision** | Screen capture and analysis using `mss` + OpenCV |
| **UI Detection** | AI-powered UI element detection via GPT-4o-mini vision |
| **UI Memory** | Persistent JSON memory for previously seen UI elements |
| **Executor** | Smart clicking — memory first, then vision fallback |
| **RL Agent** | Q-learning agent that improves action selection over time |
| **Council** | Multi-agent voting system to pick the best approach |
| **Safety** | Command filtering, dangerous pattern blocking, approval workflows |
| **Dashboard** | Real-time web dashboard for monitoring and control |
| **Cloud Server** | Remote command queue for controlling Jarvis from anywhere |
| **Agent Client** | Background agent that polls cloud server for commands |
| **Voice** | Speech-to-text (listen) + text-to-speech (speak) for hands-free control |

## Project Structure

```
jarvis_final/
├── main.py              # Entry point (CLI + server launcher)
├── config.py            # Central configuration
├── brain.py             # AI reasoning engine (GPT-4o-mini)
├── vision.py            # Screen capture (mss + OpenCV)
├── ui_vision.py         # AI-powered UI element detection
├── ui_memory.py         # Persistent UI element memory
├── executor.py          # Smart clicking (memory + vision)
├── rl_agent.py          # Q-learning reinforcement learning
├── council.py           # Multi-agent decision layer
├── safety.py            # Command safety checks
├── controller.py        # Central coordinator
├── server.py            # Local Flask API (port 5050)
├── cloud_server.py      # Cloud command queue (port 8000)
├── agent_client.py      # Cloud polling agent
├── voice.py             # Voice input/output (STT + TTS)
├── dashboard.html       # Web dashboard UI
├── memory.json          # UI memory store
├── q_table.json         # RL Q-table (auto-generated)
└── requirements.txt     # Python dependencies
```

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Set Your OpenAI API Key

```bash
export OPENAI_API_KEY="your-api-key-here"
```

Or edit `config.py` directly.

### 3. Run

**Default mode** (local server + interactive CLI):
```bash
python main.py
```

**Server only** (for dashboard use):
```bash
python main.py --server
```

**CLI only** (no server):
```bash
python main.py --cli
```

**Voice mode** (listen + speak):
```bash
python main.py --voice
```

**Everything** (local server + cloud server + agent client + CLI):
```bash
python main.py --all
```

### 4. Open Dashboard

Open `dashboard.html` in your browser. It connects to the local server at `http://127.0.0.1:5050`.

## Architecture

```
User Input (CLI / Voice / Dashboard / Cloud)
         │
         ▼
    ┌─────────┐
    │  Safety  │ ── blocks dangerous commands
    └────┬────┘
         ▼
    ┌─────────┐
    │  Brain   │ ── GPT-4o-mini plans steps (optional)
    └────┬────┘
         ▼
    ┌──────────┐
    │ Council  │ ── multiple agents vote on approach
    └────┬─────┘
         ▼
    ┌──────────┐
    │ Executor │ ── smart click (memory → vision → AI)
    └────┬─────┘
         ▼
    ┌──────────┐
    │ RL Agent │ ── learns from outcomes
    └──────────┘
```

## API Endpoints

### Local Server (port 5050)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/run` | Execute a goal (`{"goal": "search for python"}`) |
| GET | `/status` | Get bot status, logs, stats |
| GET | `/memory` | View UI memory statistics |
| POST | `/memory/clear` | Clear UI memory |
| GET | `/rl` | View RL agent statistics |
| POST | `/logs/clear` | Clear activity logs |
| GET | `/health` | Health check |

### Cloud Server (port 8000)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/command` | Queue a command (`{"command": "...", "priority": "normal\|high"}`) |
| GET | `/fetch` | Fetch next command from queue |
| GET | `/queue` | View pending commands |
| GET | `/history` | View command history |
| GET | `/health` | Health check |

## CLI Commands

| Command | Description |
|---------|-------------|
| `<any text>` | Execute as a goal |
| `/status` | Show bot statistics |
| `/logs` | Show recent activity logs |
| `/clear` | Clear logs |
| `/voice` | Switch to voice mode |
| `/help` | Show help |
| `/quit` | Exit |

## Configuration

All settings are in `config.py`:

| Setting | Default | Description |
|---------|---------|-------------|
| `OPENAI_API_KEY` | `$OPENAI_API_KEY` | Your OpenAI API key |
| `SAFE_MODE` | `True` | Enable safety checks |
| `CLICK_CONFIDENCE` | `0.6` | Minimum confidence for vision clicks |
| `RL_EPSILON` | `0.1` | RL exploration rate |
| `RL_ALPHA` | `0.1` | RL learning rate |
| `RL_GAMMA` | `0.9` | RL discount factor |

## Safety

The safety module blocks commands containing:
- Keywords: `delete`, `format`, `shutdown`, `rm -rf`, `drop table`
- Patterns: fork bombs, disk overwrites, recursive chmod on `/`

Commands with `install`, `sudo`, `download`, etc. are flagged as needing approval.

## How It Works

1. **Goal Input**: User enters a natural language goal
2. **Safety Check**: Command is checked against blocked keywords and patterns
3. **Brain Analysis**: GPT-4o-mini breaks the goal into steps (if API key is configured)
4. **Council Vote**: Multiple specialized agents vote on the best approach
5. **Execution**: The executor tries memory first, then vision-based detection
6. **Learning**: The RL agent updates Q-values based on outcomes
7. **Memory**: Successful UI element positions are stored for future use

## License

MIT
