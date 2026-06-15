"""Mycelium memory layer for hermes-agent.

Injects vault context before each turn (pre_llm_call) and captures the user
message + assistant reply after (post_llm_call), via Mycelium's HTTP bridge.

Verified against NousResearch/hermes-agent:
  - pre_llm_call  (agent/turn_context.py)   → return {"context": ...} which
    hermes appends to the user message (agent/conversation_loop.py).
  - post_llm_call (agent/turn_finalizer.py) → receives user_message AND
    assistant_response; fires once/turn, only when not interrupted.

Fail-open: every error is swallowed so a memory problem never breaks a turn.
Standard-library only (urllib) — no extra deps to install.
"""
import hashlib
import json
import logging
import os
import urllib.request

logger = logging.getLogger("mycelium-memory")


def _base():
    return (os.environ.get("MYCELIUM_BASE_URL") or "http://127.0.0.1:4711").rstrip("/")


def _bearer():
    return os.environ.get("MYCELIUM_MCP_BEARER") or ""


def _timeout():
    try:
        return float(os.environ.get("MYCELIUM_BRIDGE_TIMEOUT_MS", "4000")) / 1000.0
    except (TypeError, ValueError):
        return 4.0


def _post(path, payload):
    bearer = _bearer()
    if not bearer:
        return None
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _base() + path,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + bearer},
    )
    with urllib.request.urlopen(req, timeout=_timeout()) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


def _cap_id(conv, role, content):
    raw = "hermes|%s|%s|%s" % (conv or "", role, content)
    return "cap-" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:40]


def _text(value):
    """Coerce a hermes message (str or multimodal part list) to plain text."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "".join(
            p.get("text", "") for p in value if isinstance(p, dict) and p.get("type") == "text"
        )
    return ""


def _capture(content, role, conv, msg_id=None):
    content = (content or "").strip()
    if not content:
        return
    try:
        _post(
            "/ingest/message",
            {
                "content": content,
                "role": role,
                "source": "hermes",
                "conversationId": conv,
                "id": msg_id or _cap_id(conv, role, content),
            },
        )
    except Exception as exc:  # noqa: BLE001 — fail-open by contract
        logger.debug("mycelium capture failed: %s", exc)


def on_pre_llm_call(*, user_message=None, session_id=None, turn_id=None, **kwargs):
    """Pull vault context; return {"context": ...} for hermes to inject."""
    try:
        res = _post("/context", {"query": _text(user_message), "maxChars": 4000})
        text = (res or {}).get("text")
        if text and text.strip():
            return {"context": "# Mycelium memory (your vault)\n\n" + text}
    except Exception as exc:  # noqa: BLE001 — fail-open
        logger.debug("mycelium context failed: %s", exc)
    return None


def on_post_llm_call(*, user_message=None, assistant_response=None, session_id=None, turn_id=None, **kwargs):
    """Capture both sides of the completed turn (idempotent by turn id)."""
    base_id = "%s:%s" % (session_id or "s", turn_id or "t")
    _capture(_text(user_message), "user", session_id, base_id + ":user")
    _capture(_text(assistant_response), "assistant", session_id, base_id + ":assistant")


def register(ctx):
    """hermes plugin entry — wire the two turn hooks."""
    ctx.register_hook("pre_llm_call", on_pre_llm_call)
    ctx.register_hook("post_llm_call", on_post_llm_call)
