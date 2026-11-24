"""godspeed-forge: what the Forge waits for from the owner, handed to the model before each turn.

The Forge sends its messages (a version ready to try, a question) straight to the owner, so the chat may
not have seen them; a bare "go" would then mean nothing to the model. This reads
<workspace>/.godspeed/forge/waiting.json, the workspace being named in workspace.txt beside this file, and
returns it as injected context. Every failure returns None, so a broken Forge never breaks the assistant.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def _workspace():
    try:
        with open(os.path.join(HERE, "workspace.txt"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def context_text(waiting):
    items = [i for i in (waiting or {}).get("items", []) if isinstance(i, dict) and i.get("text")]
    if not items:
        return None
    lines = ["[godspeed-forge] The Forge waits for the owner. Its messages went straight to them and may not be in this chat; act on these with the forge skill:"]
    for item in items:
        if item.get("kind") == "staged":
            lines.append(f"- {item['text']} A reply of just \"go\" or \"make it public\" is the go for this version.")
        elif item.get("kind") == "question":
            handle = item.get("handle", "")
            lines.append(f"- Question {handle}: {item['text']} A reply that starts with {handle} answers it.")
        else:
            lines.append(f"- {item['text']}")
    return "\n".join(lines)


def on_pre_llm_call(**kwargs):
    try:
        workspace = _workspace()
        if not workspace:
            return None
        with open(os.path.join(workspace, ".godspeed", "forge", "waiting.json"), encoding="utf-8") as f:
            text = context_text(json.load(f))
        return {"context": text} if text else None
    except Exception:
        return None


def register(ctx):
    ctx.register_hook("pre_llm_call", on_pre_llm_call)
