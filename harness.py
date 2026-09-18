#!/usr/bin/env python3
"""Ephemeral Tenki sandbox agent: chats with a user via the Anthropic API to
build a small static site under ./site/, metering its own spend against a
budget. Talks to chassis only through the plain HTTP endpoints below
(/status, /export) - never touches chassis or iroh directly.
"""
import base64
import json
import mimetypes
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import anthropic

SITE_DIR = Path(__file__).parent / "site"
ALLOWED_FILES = ("index.html", "styles.css", "client.js")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
MODEL = os.environ.get("MODEL", "claude-sonnet-5")
BUDGET_USD = float(os.environ.get("BUDGET_USD", "1.00"))
PORT = int(os.environ.get("PORT", "8080"))

# Per-MTok input/output rates. Confirmed live against the real Anthropic API
# during design (2026-09): Sonnet 5 is $2/$10. Verify current published
# rates before adding another model here - do not guess.
RATES_PER_MTOK = {
    "claude-sonnet-5": {"input": 2.00, "output": 10.00},
}

# Standard Anthropic cache-pricing multipliers, applied to the base input rate.
CACHE_WRITE_5M_MULTIPLIER = 1.25
CACHE_WRITE_1H_MULTIPLIER = 2.00
CACHE_READ_MULTIPLIER = 0.10

MAX_TOOL_ITERATIONS = 8

SYSTEM_PROMPT = (
    "You are building a small static website for a user, one file at a "
    "time, using the read_file and write_file tools. You may only read or "
    "write these files: index.html, styles.css, client.js - there is no "
    "other filesystem access. Keep the site self-contained. Make small, "
    "incremental edits in response to each user request rather than "
    "rewriting everything each turn. When you believe the site satisfies "
    "the user's request, say so in your reply, but do not publish it "
    "yourself - only the user can do that."
)

TOOLS = [
    {
        "name": "read_file",
        "description": "Read the current contents of one of the site's files.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "enum": list(ALLOWED_FILES)}},
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Overwrite one of the site's files with new contents.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "enum": list(ALLOWED_FILES)},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
]

client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None

_lock = threading.Lock()
_state = {
    "status": "building",  # "building" | "published" | "budget_exhausted"
    "cost_usd": 0.0,
    "messages": [],
}


def _rate_for(model: str) -> dict:
    try:
        return RATES_PER_MTOK[model]
    except KeyError:
        raise RuntimeError(
            f"no confirmed per-token pricing for model {model!r} - add it "
            "to RATES_PER_MTOK after checking Anthropic's current "
            "published rates"
        )


def _turn_cost_usd(usage) -> float:
    rates = _rate_for(MODEL)
    input_rate = rates["input"] / 1_000_000
    output_rate = rates["output"] / 1_000_000
    cache_creation = getattr(usage, "cache_creation", None)
    cache_5m = getattr(cache_creation, "ephemeral_5m_input_tokens", 0) or 0 if cache_creation else 0
    cache_1h = getattr(cache_creation, "ephemeral_1h_input_tokens", 0) or 0 if cache_creation else 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    return (
        usage.input_tokens * input_rate
        + cache_5m * (CACHE_WRITE_5M_MULTIPLIER * input_rate)
        + cache_1h * (CACHE_WRITE_1H_MULTIPLIER * input_rate)
        + cache_read * (CACHE_READ_MULTIPLIER * input_rate)
        + usage.output_tokens * output_rate
    )


def _read_site_file(path: str) -> str:
    if path not in ALLOWED_FILES:
        raise ValueError(f"not allowed: {path}")
    fp = SITE_DIR / path
    return fp.read_text() if fp.is_file() else ""


def _write_site_file(path: str, content: str) -> None:
    if path not in ALLOWED_FILES:
        raise ValueError(f"not allowed: {path}")
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    (SITE_DIR / path).write_text(content)


def _run_tool(name: str, tool_input: dict) -> str:
    if name == "read_file":
        return _read_site_file(tool_input["path"]) or "(file does not exist yet)"
    if name == "write_file":
        _write_site_file(tool_input["path"], tool_input["content"])
        return "written"
    raise ValueError(f"unknown tool: {name}")


def run_chat_turn(user_message: str) -> dict:
    if client is None:
        return {"error": "no_api_key", "cost_usd": 0.0}
    with _lock:
        if _state["status"] != "building":
            return {"error": _state["status"], "cost_usd": _state["cost_usd"]}
        _state["messages"].append({"role": "user", "content": user_message})
        messages = list(_state["messages"])

    final_text = ""
    budget_exhausted = False
    for _ in range(MAX_TOOL_ITERATIONS):
        response = client.messages.create(
            model=MODEL,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=TOOLS,
        )

        with _lock:
            _state["cost_usd"] += _turn_cost_usd(response.usage)
            budget_exhausted = _state["cost_usd"] >= BUDGET_USD
            if budget_exhausted:
                _state["status"] = "budget_exhausted"

        assistant_content = [block.model_dump() for block in response.content]
        messages.append({"role": "assistant", "content": assistant_content})
        final_text = "\n".join(
            block.text for block in response.content if block.type == "text"
        )

        if budget_exhausted or response.stop_reason != "tool_use":
            break

        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            try:
                result = _run_tool(block.name, block.input)
                tool_results.append(
                    {"type": "tool_result", "tool_use_id": block.id, "content": result}
                )
            except Exception as exc:
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(exc),
                        "is_error": True,
                    }
                )
        messages.append({"role": "user", "content": tool_results})

    with _lock:
        _state["messages"] = messages
        return {
            "reply": final_text,
            "status": _state["status"],
            "cost_usd": _state["cost_usd"],
        }


INDEX_PAGE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Build your app</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; justify-content: center; height: 100vh; }
  #chat-pane { width: 100%; max-width: 560px; display: flex; flex-direction: column; padding: 12px; box-sizing: border-box; }
  #log { flex: 1; overflow-y: auto; font-size: 14px; }
  #log .msg { margin-bottom: 10px; white-space: pre-wrap; }
  #log .user { color: #333; font-weight: 600; }
  #log .assistant { color: #0a5; }
  #status-bar { font-size: 12px; color: #666; margin-bottom: 8px; }
  textarea { width: 100%; box-sizing: border-box; }
  #preview-buttons { display: flex; gap: 8px; margin-top: 6px; }
  #preview-buttons button { flex: 1; }
  button { margin-top: 6px; }
  #publish-btn { background: #0a5; color: white; border: none; padding: 8px; cursor: pointer; }
  #publish-btn:disabled { background: #999; cursor: default; }
</style>
</head>
<body>
<div id="chat-pane">
  <div id="status-bar">status: <span id="status">building</span> - cost: $<span id="cost">0.0000</span> / $<span id="budget">?</span></div>
  <div id="log"></div>
  <div id="preview-buttons">
    <button id="preview-computer-btn">Preview (Computer)</button>
    <button id="preview-mobile-btn">Preview (Mobile)</button>
  </div>
  <textarea id="input" rows="3" placeholder="Describe what you want..."></textarea>
  <button id="send-btn">Send</button>
  <button id="publish-btn">Publish</button>
</div>
<script>
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const publishBtn = document.getElementById('publish-btn');
const statusEl = document.getElementById('status');
const costEl = document.getElementById('cost');
const budgetEl = document.getElementById('budget');

// The live preview opens in its own window rather than an inline iframe,
// so it can be sized like a real device viewport (window.open's
// width/height only size the outer window, not the content area, so this
// is an approximation - close enough to trigger real CSS breakpoints,
// not pixel-perfect device emulation). Kept as a plain window reference
// (not reopened every time) so repeat clicks resize/reuse the same
// window, and so a chat turn can refresh its content without needing a
// new user gesture (window.open outside a click handler risks being
// popup-blocked; navigating an already-open window is not).
let previewWindow = null;

function openPreview(kind) {
  const width = kind === 'mobile' ? 390 : 1280;
  const height = kind === 'mobile' ? 844 : 800;
  const url = '/preview/index.html?t=' + Date.now();
  if (previewWindow && !previewWindow.closed) {
    previewWindow.resizeTo(width, height);
    previewWindow.location.href = url;
    previewWindow.focus();
  } else {
    previewWindow = window.open(url, 'app-preview', `width=${width},height=${height}`);
  }
}

function refreshPreview() {
  if (previewWindow && !previewWindow.closed) {
    previewWindow.location.href = '/preview/index.html?t=' + Date.now();
  }
}

// This page runs inside chassis's create-app iframe, so it unloads
// whenever that outer tab is closed, reloaded, or navigated away from -
// close the preview window along with it rather than leaving an orphaned
// popup behind. A window can still be closed by the script that opened
// it even after the popup itself has navigated elsewhere (e.g. following
// a chat-driven refresh), so this works regardless of what's currently
// loaded in it.
window.addEventListener('pagehide', () => {
  if (previewWindow && !previewWindow.closed) {
    previewWindow.close();
  }
});

document.getElementById('preview-computer-btn').addEventListener('click', () => openPreview('computer'));
document.getElementById('preview-mobile-btn').addEventListener('click', () => openPreview('mobile'));

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

async function refreshStatus() {
  const r = await fetch('/status');
  const j = await r.json();
  statusEl.textContent = j.status;
  costEl.textContent = j.cost_usd.toFixed(4);
  budgetEl.textContent = j.budget_usd.toFixed(2);
  const disabled = j.status !== 'building';
  input.disabled = disabled;
  sendBtn.disabled = disabled;
  publishBtn.disabled = disabled;
}

async function send() {
  const message = input.value.trim();
  if (!message) return;
  addMsg('user', message);
  input.value = '';
  sendBtn.disabled = true;
  try {
    const r = await fetch('/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message}),
    });
    const j = await r.json();
    if (j.error) {
      addMsg('assistant', 'Error: ' + j.error);
    } else {
      addMsg('assistant', j.reply || '(no reply)');
      refreshPreview();
    }
  } finally {
    await refreshStatus();
  }
}

publishBtn.addEventListener('click', async () => {
  publishBtn.disabled = true;
  await fetch('/publish', {method: 'POST'});
  await refreshStatus();
});

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

refreshStatus();
setInterval(refreshStatus, 5000);
</script>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, html, status=200):
        body = html.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_site_file(self, name):
        if name not in ALLOWED_FILES:
            self._send_json({"error": "not found"}, status=404)
            return
        fp = SITE_DIR / name
        if not fp.is_file():
            self._send_json({"error": "not found"}, status=404)
            return
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        body = fp.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            self._send_html(INDEX_PAGE)
        elif path == "/status":
            with _lock:
                self._send_json(
                    {
                        "status": _state["status"],
                        "cost_usd": _state["cost_usd"],
                        "budget_usd": BUDGET_USD,
                    }
                )
        elif path == "/export":
            files = []
            for name in ALLOWED_FILES:
                fp = SITE_DIR / name
                if fp.is_file():
                    files.append(
                        {
                            "path": name,
                            "content_base64": base64.b64encode(fp.read_bytes()).decode(),
                        }
                    )
            self._send_json({"files": files})
        elif path in ("/preview", "/preview/"):
            self._serve_site_file("index.html")
        elif path.startswith("/preview/"):
            self._serve_site_file(path[len("/preview/"):])
        else:
            self._send_json({"error": "not found"}, status=404)

    def do_POST(self):
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send_json({"error": "invalid json"}, status=400)
            return

        if path == "/chat":
            message = payload.get("message", "")
            if not message:
                self._send_json({"error": "message required"}, status=400)
                return
            try:
                result = run_chat_turn(message)
            except Exception as exc:
                self._send_json({"error": str(exc)}, status=500)
                return
            self._send_json(result)
        elif path == "/publish":
            with _lock:
                if _state["status"] != "budget_exhausted":
                    _state["status"] = "published"
                status, cost = _state["status"], _state["cost_usd"]
            self._send_json({"status": status, "cost_usd": cost})
        else:
            self._send_json({"error": "not found"}, status=404)


def main():
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"harness listening on :{PORT}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
