"""
ai/learning_engine.py

Tracks task execution history, computes success rates per task type,
and provides feedback signals that the task planner uses to improve future prompts.
"""

import json
import logging
import os
from collections import defaultdict, deque
from datetime import datetime

logger = logging.getLogger("LearningEngine")

HISTORY_FILE      = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs", "task_history.json")
ROLLING_WINDOW    = 20
FAILURE_THRESHOLD = 0.3


class LearningEngine:
    """
    Stores task execution results and provides learning signals to the planner.
    """

    def __init__(self):
        self.results       = deque(maxlen=500)
        self.per_task      = defaultdict(lambda: deque(maxlen=ROLLING_WINDOW))
        self.session_start = datetime.utcnow().isoformat()
        self._load_persisted()
        logger.info("LearningEngine initialised")

    # -------------------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------------------

    def record_result(self, task_name, success, duration_ms, message="", context_summary=None):
        """Records the outcome of a single task execution."""
        entry = {
            "task"       : task_name,
            "success"    : success,
            "duration_ms": duration_ms,
            "message"    : message,
            "timestamp"  : datetime.utcnow().isoformat(),
            "context"    : context_summary or {},
        }
        self.results.append(entry)
        self.per_task[task_name].append(success)

        status = "SUCCESS" if success else "FAILURE"
        logger.info("[%s] %s (%dms): %s", status, task_name, duration_ms, message[:60])

        if len(self.results) % 10 == 0:
            self._persist()

    def get_success_rate(self, task_name):
        """Returns rolling success rate 0.0-1.0 for a task. Returns 0.5 if no history."""
        history = self.per_task.get(task_name)
        if not history:
            return 0.5
        return sum(history) / len(history)

    def get_flagged_tasks(self):
        """Returns tasks whose rolling success rate is below FAILURE_THRESHOLD."""
        flagged = []
        for task_name, history in self.per_task.items():
            if len(history) < 3:
                continue
            rate = sum(history) / len(history)
            if rate < FAILURE_THRESHOLD:
                flagged.append({
                    "task"        : task_name,
                    "success_rate": round(rate, 2),
                    "sample_size" : len(history),
                })
        return flagged

    def get_learning_summary(self):
        """
        Builds a short text block injected into the AI prompt to guide planning.
        Returns a plain string (no bare newlines inside string literals).
        """
        lines = ["=== LEARNING SIGNALS ==="]

        total   = len(self.results)
        success = sum(1 for r in self.results if r["success"])
        if total > 0:
            pct = round(success / total * 100)
            lines.append(
                "Session: {s}/{t} tasks succeeded ({p}% overall)".format(
                    s=success, t=total, p=pct
                )
            )

        task_lines = []
        for task_name, history in sorted(self.per_task.items()):
            if len(history) < 2:
                continue
            rate  = sum(history) / len(history)
            bar   = "#" * round(rate * 10) + "." * (10 - round(rate * 10))
            task_lines.append(
                "  {n:<30} {b} {p}%".format(
                    n=task_name, b=bar, p=round(rate * 100)
                )
            )
        if task_lines:
            lines.append("Task success rates (rolling):")
            lines.extend(task_lines)

        flagged = self.get_flagged_tasks()
        if flagged:
            lines.append("AVOID these tasks (consistently failing):")
            for f in flagged:
                lines.append(
                    "  x {t} ({r:.0f}% success)".format(
                        t=f["task"], r=f["success_rate"] * 100
                    )
                )

        return "\n".join(lines)

    def get_recent_results(self, n=10):
        """Returns the last n task results."""
        return list(self.results)[-n:]

    def get_stats(self):
        """Returns a structured stats dict for the /status API endpoint."""
        total   = len(self.results)
        success = sum(1 for r in self.results if r["success"])
        per_task = {}
        for name, h in self.per_task.items():
            per_task[name] = {
                "success_rate": round(sum(h) / len(h), 2) if h else 0.5,
                "sample_size" : len(h),
            }
        return {
            "session_start"  : self.session_start,
            "total_tasks"    : total,
            "overall_success": round(success / total, 2) if total else 0,
            "per_task"       : per_task,
            "flagged_tasks"  : self.get_flagged_tasks(),
        }

    # -------------------------------------------------------------------------
    # Persistence
    # -------------------------------------------------------------------------

    def _persist(self):
        """Saves current results to a JSON file for cross-session learning."""
        try:
            os.makedirs(os.path.dirname(HISTORY_FILE), exist_ok=True)
            with open(HISTORY_FILE, "w") as f:
                json.dump(list(self.results), f, indent=2)
        except Exception as e:
            logger.warning("Could not persist task history: %s", e)

    def _load_persisted(self):
        """Loads previously saved task history on startup."""
        if not os.path.exists(HISTORY_FILE):
            return
        try:
            with open(HISTORY_FILE, "r") as f:
                saved = json.load(f)
            for entry in saved[-200:]:
                self.results.append(entry)
                self.per_task[entry["task"]].append(entry["success"])
            logger.info("Loaded %d historical task results from disk", len(saved))
        except Exception as e:
            logger.warning("Could not load persisted history: %s", e)