"""
ai/prompts.py

All prompt templates used by the task planner when querying the Ollama llama3.1 model.
"""

# Available task names the bot can execute (keep in sync with actions.js)
AVAILABLE_TASKS = [
    "explore", "collect_wood", "collect_stone", "collect_coal", "collect_iron",
    "collect_food", "eat", "craft_planks", "craft_crafting_table", "craft_sticks",
    "craft_wooden_pickaxe", "craft_stone_pickaxe", "craft_iron_pickaxe",
    "craft_wooden_sword", "craft_stone_sword", "build_shelter",
    "place_crafting_table", "place_furnace", "smelt_iron",
    "attack_mob", "flee_danger", "sleep", "wait",
]

SYSTEM_PROMPT = (
    "You are an autonomous Minecraft survival agent.\n"
    "Your goal is to survive, thrive, and progressively advance like a skilled human player.\n"
    "\n"
    "You will receive a snapshot of the bot state and must respond with a JSON task plan.\n"
    "\n"
    "RULES:\n"
    "1. Respond ONLY with raw JSON — no preamble, no markdown, no explanation outside the JSON.\n"
    "2. Tasks must be chosen from the AVAILABLE_TASKS list provided.\n"
    "3. Prioritise survival: flee or eat before any other activity when in danger.\n"
    "4. Think ahead: if it is night, prepare shelter or sleep; if food is low, eat or hunt first.\n"
    "5. Progress logically: wood -> planks -> crafting table -> tools -> stone -> iron -> shelter.\n"
    "6. Never repeat a task that just failed unless the situation has changed.\n"
    "7. Order tasks by priority (1 = highest).\n"
    "\n"
    "RESPONSE SCHEMA:\n"
    "{\n"
    '  "goal": "<short description of the overall current goal>",\n'
    '  "reasoning": "<one sentence explaining why you chose this goal>",\n'
    '  "tasks": [\n'
    "    {\n"
    '      "name": "<task name from AVAILABLE_TASKS>",\n'
    '      "params": {},\n'
    '      "priority": 1,\n'
    '      "reason": "<one short phrase>"\n'
    "    }\n"
    "  ]\n"
    "}\n"
    "\n"
    "AVAILABLE_TASKS: " + ", ".join(AVAILABLE_TASKS) + "\n"
    "\n"
    "PARAMS REFERENCE (all optional):\n"
    '  explore:              { "radius": 32 }\n'
    '  collect_wood:         { "count": 8 }\n'
    '  collect_stone:        { "count": 16 }\n'
    '  collect_coal:         { "count": 8 }\n'
    '  collect_iron:         { "count": 8 }\n'
    '  attack_mob:           { "targetName": "zombie" }\n'
    '  flee_danger:          { "distance": 20 }\n'
    '  wait:                 { "seconds": 5 }\n'
)


def format_context(context: dict) -> str:
    """
    Converts the raw bot context dict into a compact human-readable string
    that llama3.1 can reason about more easily than raw JSON.
    """
    pos      = context.get("position", {})
    vitals   = context.get("vitals", {})
    inv      = context.get("inventory", {}).get("summary", {})
    time_ctx = context.get("time", {})
    blocks   = context.get("nearbyBlocks", {})
    entities = context.get("entities", {})
    dangers  = context.get("dangers", [])
    biome    = context.get("biome", "unknown")
    chat     = context.get("recentChat", [])

    block_summary = ", ".join(
        "{count}x {name}".format(count=v["count"], name=name)
        for name, v in list(blocks.items())[:10]
    ) or "none detected"

    hostile_summary = ", ".join(
        "{name}({dist}m)".format(name=e["name"], dist=e["distance"])
        for e in entities.get("hostiles", [])[:5]
    ) or "none"

    passive_summary = ", ".join(
        e["name"] for e in entities.get("passives", [])[:5]
    ) or "none"

    tools  = ", ".join(inv.get("tools", [])) or "none"
    armor  = ", ".join(inv.get("armor", [])) or "none"
    misc   = ", ".join(inv.get("misc", [])[:6]) or "none"

    danger_summary = "; ".join(
        "{t}(severity={s})".format(t=d["type"], s=d["severity"])
        for d in dangers
    ) or "none"

    chat_summary = " | ".join(
        "{u}: {m}".format(u=c["username"], m=c["message"])
        for c in chat[-3:]
    ) or "none"

    lines = [
        "=== BOT STATE ===",
        "Position   : x={x}, y={y}, z={z}".format(**pos),
        "Biome      : {b}".format(b=biome),
        "Time       : {p} (isNight={n}, raining={r})".format(
            p=time_ctx.get("period"),
            n=time_ctx.get("isNight"),
            r=time_ctx.get("raining"),
        ),
        "",
        "=== VITALS ===",
        "Health     : {h}/20".format(h=vitals.get("health")),
        "Food       : {f}/20".format(f=vitals.get("food")),
        "Experience : level {e}".format(e=vitals.get("experience")),
        "Game mode  : {g}".format(g=vitals.get("gameMode")),
        "",
        "=== INVENTORY ===",
        "Wood       : {w} units".format(w=inv.get("wood", 0)),
        "Food items : {f} units".format(f=inv.get("food", 0)),
        "Stone      : {s} units".format(s=inv.get("stone", 0)),
        "Ore/metals : {o} units".format(o=inv.get("ore", 0)),
        "Tools      : {t}".format(t=tools),
        "Armor      : {a}".format(a=armor),
        "Other      : {m}".format(m=misc),
        "",
        "=== ENVIRONMENT ===",
        "Nearby blocks : {b}".format(b=block_summary),
        "Hostile mobs  : {h}".format(h=hostile_summary),
        "Passive mobs  : {p}".format(p=passive_summary),
        "",
        "=== DANGERS ===",
        danger_summary,
        "",
        "=== RECENT CHAT ===",
        chat_summary,
    ]
    return "\n".join(lines)


def format_history(history: list) -> str:
    """
    Formats recent task history into a compact summary for the AI.
    """
    if not history:
        return "No task history yet."

    lines = []
    for h in history[-8:]:
        status = "OK" if h.get("success") else "FAIL"
        msg = (h.get("message") or "")[:60]
        lines.append(
            "  [{s}] {t} -- {m}".format(s=status, t=h.get("taskName"), m=msg)
        )

    return "=== RECENT TASK HISTORY ===\n" + "\n".join(lines)


def build_user_message(context: dict, history: list) -> str:
    """
    Assembles the complete user message sent to llama3.1.
    """
    ctx_block  = format_context(context)
    hist_block = format_history(history)
    return ctx_block + "\n\n" + hist_block + (
        "\n\nBased on the above state, generate a task plan as a JSON object "
        "following the schema. Respond ONLY with raw JSON."
    )