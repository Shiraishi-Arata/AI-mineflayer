"""
ai/task_planner.py

Flask HTTP server — the bridge between the Mineflayer bot and the Ollama AI.

Endpoints:
  POST /plan     -- receive bot context, query Ollama, return task plan
  POST /result   -- receive task result, update learning engine
  GET  /health   -- liveness check
  GET  /status   -- learning stats and session overview
  GET  /history  -- recent task result history
"""

import json
import logging
import os
import re
import sys
import time
from datetime import datetime

from flask import Flask, request, jsonify

# Add the ai/ directory to path so sibling modules resolve correctly
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ollama
from prompts import SYSTEM_PROMPT, build_user_message
from learning_engine import LearningEngine

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
_logs_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs")
os.makedirs(_logs_dir, exist_ok=True)

logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(
            os.path.join(_logs_dir, "planner-{d}.log".format(
                d=datetime.now().strftime("%Y-%m-%d")
            ))
        ),
    ]
)
logger = logging.getLogger("TaskPlanner")

# ---------------------------------------------------------------------------
# App + globals
# ---------------------------------------------------------------------------
app = Flask(__name__)

learner = LearningEngine()

OLLAMA_MODEL  = os.getenv("OLLAMA_MODEL",   "llama3.1")
OLLAMA_HOST   = os.getenv("OLLAMA_HOST",    "http://localhost:11434")
PLANNER_PORT  = int(os.getenv("PLANNER_PORT", "5000"))
MAX_TOKENS    = int(os.getenv("MAX_TOKENS",   "1024"))
TEMPERATURE   = float(os.getenv("TEMPERATURE", "0.7"))

request_count = 0

logger.info("Task planner configured -- model=%s, port=%d", OLLAMA_MODEL, PLANNER_PORT)


# ===========================================================================
# Endpoints
# ===========================================================================

@app.route("/health", methods=["GET"])
def health():
    """Liveness check -- confirms server is running and Ollama is reachable."""
    ollama_ok = False
    try:
        models     = ollama.list()
        model_list = models.get("models", [])
        ollama_ok  = any(OLLAMA_MODEL in m.get("name", "") for m in model_list)
    except Exception as exc:
        logger.warning("Ollama health check failed: %s", exc)

    return jsonify({
        "status"          : "ok",
        "model"           : OLLAMA_MODEL,
        "ollama_ok"       : ollama_ok,
        "requests_served" : request_count,
        "timestamp"       : datetime.utcnow().isoformat(),
    })


@app.route("/plan", methods=["POST"])
def plan():
    """
    Receives bot context and returns a structured task plan from the AI.

    Request body:
        { "context": {...}, "history": [...], "request_id": 42 }

    Response body:
        { "goal": "...", "reasoning": "...", "tasks": [...], "source": "ai" }
    """
    global request_count
    request_count += 1
    req_id = request_count

    logger.info("[req#%d] /plan received", req_id)
    data = request.get_json(silent=True)

    if not data or "context" not in data:
        logger.warning("[req#%d] Missing context in request body", req_id)
        return jsonify({"error": "Missing context"}), 400

    context = data["context"]
    history = data.get("history", [])

    # Build the prompt
    learning_summary  = learner.get_learning_summary()
    user_msg          = build_user_message(context, history)
    full_user_message = user_msg + "\n\n" + learning_summary

    logger.info("[req#%d] Querying Ollama (%s)...", req_id, OLLAMA_MODEL)
    start_time = time.time()

    try:
        response = ollama.chat(
            model   = OLLAMA_MODEL,
            options = {
                "temperature" : TEMPERATURE,
                "num_predict" : MAX_TOKENS,
                "stop"        : ["```", "---"],
            },
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user",   "content": full_user_message},
            ],
        )

        elapsed  = round((time.time() - start_time) * 1000)
        raw_text = response["message"]["content"]
        logger.info("[req#%d] Ollama responded in %dms (%d chars)", req_id, elapsed, len(raw_text))
        logger.debug("[req#%d] Raw: %s", req_id, raw_text[:300])

        result_plan              = _parse_ai_response(raw_text, req_id)
        result_plan["source"]    = "ai"
        result_plan["elapsed_ms"]= elapsed

        logger.info("[req#%d] Plan: goal=%r, tasks=%d",
                    req_id, result_plan.get("goal"), len(result_plan.get("tasks", [])))
        return jsonify(result_plan)

    except Exception as exc:
        elapsed = round((time.time() - start_time) * 1000)
        logger.error("[req#%d] Ollama query failed after %dms: %s", req_id, elapsed, exc)
        fallback              = _fallback_plan(context)
        fallback["source"]    = "fallback_error"
        fallback["error"]     = str(exc)
        return jsonify(fallback)


@app.route("/result", methods=["POST"])
def result():
    """
    Receives the outcome of a completed task from the bot.
    Used by the LearningEngine to track success rates.
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "Empty body"}), 400

    task_name = data.get("taskName", "unknown")
    success   = data.get("success",  False)
    duration  = data.get("duration", 0)
    message   = data.get("message",  "")
    ctx       = data.get("context",  {})

    ctx_summary = {
        "pos"   : ctx.get("position"),
        "health": ctx.get("vitals", {}).get("health"),
        "time"  : ctx.get("time",   {}).get("period"),
    }
    learner.record_result(task_name, success, duration, message, ctx_summary)
    return jsonify({"recorded": True})


@app.route("/status", methods=["GET"])
def status():
    """Returns session-wide learning statistics."""
    return jsonify(learner.get_stats())


@app.route("/history", methods=["GET"])
def history():
    """Returns the last N task results. Query param: ?n=20"""
    n = int(request.args.get("n", 20))
    return jsonify(learner.get_recent_results(n))


# ===========================================================================
# Helpers
# ===========================================================================

def _parse_ai_response(raw, req_id):
    """
    Attempts to extract valid JSON from the model raw text output.
    Falls back through three strategies before giving up.
    """
    # Strategy 1: direct parse
    try:
        return json.loads(raw.strip())
    except (json.JSONDecodeError, ValueError):
        pass

    # Strategy 2: strip markdown fences
    stripped = re.sub(r"```(?:json)?", "", raw).strip()
    try:
        return json.loads(stripped)
    except (json.JSONDecodeError, ValueError):
        pass

    # Strategy 3: regex extract first {...} block
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except (json.JSONDecodeError, ValueError):
            pass

    logger.warning("[req#%d] Could not parse JSON from model response", req_id)
    logger.debug("[req#%d] Unparseable: %s", req_id, raw[:200])
    return _fallback_plan_from_text(raw)


def _fallback_plan(context):
    """
    Generates a safe deterministic fallback plan based on bot context.
    Used when Ollama is unavailable or returns unreadable output.
    """
    dangers  = context.get("dangers", [])
    vitals   = context.get("vitals",  {})
    inv      = context.get("inventory", {}).get("summary", {})
    time_ctx = context.get("time", {})
    tasks    = []
    goal     = "safe_fallback"

    danger_types = [d.get("type") for d in dangers]

    if "low_health" in danger_types:
        tasks = [
            {"name": "flee_danger", "params": {},          "priority": 1, "reason": "low health"},
            {"name": "eat",         "params": {},          "priority": 2, "reason": "recover"},
        ]
        goal = "emergency_survival"

    elif vitals.get("food", 20) < 8:
        tasks = [
            {"name": "eat",          "params": {},         "priority": 1, "reason": "hungry"},
            {"name": "collect_food", "params": {},         "priority": 2, "reason": "gather food"},
        ]
        goal = "address_hunger"

    elif time_ctx.get("isNight"):
        if inv.get("stone", 0) > 8 or "crafting_table" in inv.get("misc", []):
            tasks = [{"name": "build_shelter", "params": {}, "priority": 1, "reason": "night time"}]
        else:
            tasks = [{"name": "collect_wood", "params": {"count": 8}, "priority": 1, "reason": "night prep"}]
        goal = "survive_night"

    else:
        tools = inv.get("tools", [])
        if inv.get("wood", 0) < 8:
            tasks = [{"name": "collect_wood", "params": {"count": 8}, "priority": 1, "reason": "need wood"}]
        elif not any("pickaxe" in t for t in tools):
            tasks = [
                {"name": "craft_planks",          "params": {},  "priority": 1, "reason": "need planks"},
                {"name": "craft_crafting_table",  "params": {},  "priority": 2, "reason": "need table"},
                {"name": "craft_sticks",           "params": {},  "priority": 3, "reason": "need sticks"},
                {"name": "craft_wooden_pickaxe",   "params": {},  "priority": 4, "reason": "need pickaxe"},
            ]
        else:
            tasks = [{"name": "explore", "params": {"radius": 32}, "priority": 1, "reason": "explore"}]
        goal = "resource_gathering"

    if not tasks:
        tasks = [{"name": "explore", "params": {}, "priority": 1, "reason": "default"}]

    return {
        "goal"     : goal,
        "reasoning": "Deterministic fallback plan (AI unavailable)",
        "tasks"    : tasks,
    }


def _fallback_plan_from_text(text):
    """
    Last-resort: scan model plain-English text for task keywords.
    """
    text_lower = text.lower()
    keyword_map = [
        ("flee",    "flee_danger"),
        ("escape",  "flee_danger"),
        ("eat",     "eat"),
        ("food",    "collect_food"),
        ("wood",    "collect_wood"),
        ("log",     "collect_wood"),
        ("craft",   "craft_crafting_table"),
        ("pickaxe", "craft_wooden_pickaxe"),
        ("stone",   "collect_stone"),
        ("shelter", "build_shelter"),
        ("explore", "explore"),
        ("sleep",   "sleep"),
    ]
    tasks = []
    seen  = set()
    for keyword, task_name in keyword_map:
        if keyword in text_lower and task_name not in seen:
            tasks.append({"name": task_name, "params": {}, "priority": len(tasks) + 1, "reason": "inferred"})
            seen.add(task_name)
            if len(tasks) >= 4:
                break

    if not tasks:
        tasks = [{"name": "explore", "params": {}, "priority": 1, "reason": "default"}]

    return {
        "goal"     : "inferred_from_text",
        "reasoning": "JSON parsing failed -- tasks inferred from model text",
        "tasks"    : tasks,
    }


# ===========================================================================
# Entry point
# ===========================================================================

if __name__ == "__main__":
    logger.info("Starting Task Planner on port %d", PLANNER_PORT)
    logger.info("Ollama model : %s", OLLAMA_MODEL)

    try:
        models     = ollama.list()
        names      = [m.get("name", "") for m in models.get("models", [])]
        logger.info("Ollama connected. Models: %s", names)
        if not any(OLLAMA_MODEL in n for n in names):
            logger.warning("Model %r not found. Run: ollama pull %s", OLLAMA_MODEL, OLLAMA_MODEL)
    except Exception as exc:
        logger.error("Cannot connect to Ollama: %s", exc)
        logger.error("Make sure Ollama is running: ollama serve")

    app.run(host="0.0.0.0", port=PLANNER_PORT, debug=False)