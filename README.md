# 🤖 Minecraft AI Bot — Autonomous Agent with Ollama + Mineflayer

A production-ready autonomous Minecraft bot powered by a local Ollama LLM (llama3.1),
Mineflayer for world interaction, and a Python task-planning system. The bot
observes the environment, reasons about what to do next, and executes goals — just
like a human player would.

---

## 📁 Project Structure

```
minecraft-ai-bot/
│
├── bot/
│   ├── bot.js          # Entry point — boots Mineflayer, wires all modules
│   ├── navigation.js   # Pathfinder-based movement and exploration
│   ├── actions.js      # Task execution (mining, crafting, building, etc.)
│   ├── sensors.js      # Environment observation and state gathering
│   └── aiClient.js     # HTTP bridge to the Python AI planner
│
├── ai/
│   ├── task_planner.py    # Flask server — receives context, queries Ollama
│   ├── learning_engine.py # Tracks task history, success rates, expansions
│   └── prompts.py         # All prompt templates for Ollama
│
├── config/
│   └── config.json     # Server host, port, AI settings, bot settings
│
├── utils/
│   └── logger.js       # Colour-coded structured logger
│
├── logs/               # Runtime log files
│
├── package.json
└── README.md
```

---

## ✅ Prerequisites

| Tool | Version |
|------|---------|
| Node.js | >= 18.x |
| Python | >= 3.10 |
| Ollama | Latest |
| Minecraft Java | 1.20.x (or as configured) |

---

## 📦 Installation

### 1. Clone / create the project

```bash
cd minecraft-ai-bot
```

### 2. Install Node.js dependencies

```bash
npm install
```

### 3. Install Python dependencies

```bash
pip install flask requests ollama
# or use a virtual environment:
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install flask requests ollama
```

### 4. Install Ollama

Linux / macOS:
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Windows: Download from https://ollama.com/download

### 5. Pull the llama3.1 model

```bash
ollama pull llama3.1
ollama run llama3.1 "Say hello"
```

---

## ⚙️ Configuration

Edit config/config.json to match your setup.

---

## 🚀 Running the System

### Step 1 — Start Ollama
```bash
ollama serve
```

### Step 2 — Start the Python AI Planner
```bash
python ai/task_planner.py
```

### Step 3 — Start a Minecraft Server (local testing)
```bash
docker run -e EULA=TRUE -p 25565:25565 itzg/minecraft-server
```

### Step 4 — Launch the Bot
```bash
node bot/bot.js
```

---

## 🧠 How AI Reasoning Works

1. Sensors gather the bot state (position, inventory, health, blocks, entities, time).
2. aiClient.js POSTs this state to the Python planner.
3. task_planner.py formats a prompt and queries Ollama (llama3.1).
4. Ollama returns a JSON task plan.
5. learning_engine.py records results and adjusts future prompts.
6. actions.js executes the task list one step at a time.
7. The loop repeats every N seconds (configurable).

---

## ✏️ Modifying AI Prompts

All prompts live in ai/prompts.py. Edit SYSTEM_PROMPT or the task format there.

## 🔧 Extending the Task System

1. Add a handler in bot/actions.js
2. Register it in the task dispatcher (switch/case block)
3. Add it to the prompt examples in ai/prompts.py

## 📝 License

MIT
