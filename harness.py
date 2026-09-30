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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import anthropic

SITE_DIR = Path(__file__).parent / "site"
# chat-widget.js and payment-widget.js are pre-seeded, ready-made components
# (see CHASSIS_REFERENCE below) - listed here so they're read/write-able
# like the other three, and so /export and /preview serve them, but the
# model isn't expected to write them from scratch the way it does
# index.html/styles.css/client.js.
ALLOWED_FILES = ("index.html", "styles.css", "client.js", "chat-widget.js", "payment-widget.js")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
MODEL = os.environ.get("MODEL", "claude-sonnet-5")
BUDGET_USD = float(os.environ.get("BUDGET_USD", "1.00"))
PORT = int(os.environ.get("PORT", "8080"))

# Tenki's own default sandbox session lifetime (confirmed live 2026-09-30
# against a real CreateSession response: timeoutAt was exactly 30 minutes
# after createdAt) - the platform kills the sandbox at this point
# regardless of anything the harness does, so this is a real countdown to
# match against, not an arbitrary pick. There is no way to read this value
# from inside the sandbox itself (Tenki's timeoutAt is chassis-side only,
# never passed into CreateSession's env) - if Tenki's default ever
# changes, update this constant to match.
SESSION_MAX_LIFETIME_SECS = 30 * 60

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

# Real, working reference patterns for the platform that will eventually
# serve this site - copied from that platform's own client code (chat.js),
# not reconstructed from memory, so the shapes here (route names, param
# names, response fields) are exactly correct rather than plausible-looking.
# None of this can be exercised from inside this preview: the sandbox this
# chat session runs in has no network route to that platform at all, only
# outbound access to the Anthropic API. It only starts working once the
# finished site is actually imported - the model is told this explicitly
# below so it can pass the caveat on to the user rather than presenting a
# feature that looks broken as if it should already work here.
CHASSIS_REFERENCE = """

If the user wants something that needs shared, multi-visitor data - a
chat room, guestbook, live feed, or anything else visitors write and
read back - you can write real, working client-side code for it against
the platform that will host this site, using the patterns below. It will
NOT do anything in this preview (the sandbox you're running in has no
route to that platform); it starts working the moment the user imports
the finished site, because at that point the site is served BY the same
platform these calls target, from the same origin. Say this plainly to
the user whenever you add a feature like this, so a silently "broken"
preview doesn't read as a bug.

For a CHAT feature specifically, a ready-made, already-styled component is
always present in this site's own files - `chat-widget.js`, alongside
index.html/styles.css/client.js. Prefer it over hand-writing chat bubbles
from scratch: it matches this platform's own standalone chat app
pixel-for-pixel (same colors, same speech-bubble shapes, same self/other
logic), so a chat feature built this way looks like a native part of the
platform rather than a bespoke reskin. Wire it up with:

  <div id="chat"></div>
  <script src="chat-widget.js"></script>
  <script>
    mountChatTopic(document.getElementById('chat'), {topicName: 'general'});
  </script>

By default it mints its own private feed the first time someone sends a
message - no setup step, no ticket, same underlying mechanism as the
guestbook/feed pattern below, just pre-styled and pre-wired. Only fall back
to the raw patterns further below if the user wants something chat-widget.js
doesn't cover (a non-chat feed/guestbook with custom fields, or a fully
custom visual style the user explicitly asked for instead of the platform's
own look).

If the user wants THIS widget to share one live conversation with the
platform's own standalone chat app (visible and postable from both
places), pass `namespace` and `writeTicket` for a topic the user already
created there through its own "New Topic" button, and gave you the ticket
for (visible via that topic's own share/ticket action). Generated code has
no way to mint a topic the chat app will also discover on its own - only a
topic the user creates in the chat app first can be shared this way:

  mountChatTopic(document.getElementById('chat'), {
    topicName: 'general',
    namespace: '<namespace the user gave you>',
    writeTicket: '<write ticket the user gave you>',
  });

Read `chat-widget.js` (via read_file) before customizing chat behavior -
it's plain, commented JS, not a black box, and documents both modes above
in its own header comment.

For a PAYMENT feature - charging a real price in crypto for something on
this site - a ready-made component is likewise always present:
`payment-widget.js`. It drives the wallet (Freighter for Stellar, MetaMask
for Ethereum/Polygon) to build and sign a real USDC-testnet payment to a
destination address you choose, then has this platform independently
verify the on-chain transaction before telling you it's paid - it never
trusts the wallet's or the page's own claim. Wire it up with:

  <div id="pay"></div>
  <script src="payment-widget.js"></script>
  <script>
    mountPaymentWidget(document.getElementById('pay'), {
      amountUsd: 5,
      description: 'One month of premium',
      destination: {
        stellar: 'G...',  // ask the user for their own Stellar testnet address
        evm: '0x...',     // ask the user for their own EVM address
      },
      onPaid(receipt) {
        // receipt = { verified, chain, network, destination, asset,
        //             amount_usd, tx_hash, receipt }
        // Decide what "paid" unlocks on this page - there is no
        // platform-side session or purchase record kept for you. If you
        // want durable proof of payment, write `receipt` into this site's
        // own document (see the guestbook/feed pattern below for how) -
        // it's signed by the platform's own key, so it can't be forged by
        // editing the page's client-side state.
      },
    });
  </script>

You MUST ask the user for their own receiving address(es) before wiring
this in - `destination` is where THEIR money goes, this platform has no
way to know it and must not guess or reuse an address seen elsewhere.
Pass just `stellar`, just `evm`, or both; only the chain(s) you give a
destination for are offered to the payer. Read `payment-widget.js` (via
read_file) before customizing payment behavior - it's plain, commented JS,
documenting exactly what it sends and expects back.

Always resolve calls relative to the page's own current URL, never a
hardcoded origin or absolute path - the site's eventual mount point (by
name, by an opaque id, possibly behind a reverse-proxy prefix) isn't
something this code can know in advance:

  const API_BASE = new URL('.', window.location.href);
  function apiUrl(path) { return new URL(path, API_BASE).toString(); }
  async function fetchJson(path, options) {
    const response = await fetch(apiUrl(path), options);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  }

The simple, common case - one shared feed living on this site's own
document (a guestbook, a comment thread, a single chat room) - needs no
setup step and no credential in the request; write access is a property
of the server that ends up hosting the site, not of who's asking:

  // write one entry
  const body = JSON.stringify({sender, ts: Date.now(), text});
  const blob = await fetchJson('blob', {method: 'POST', body});
  const key = `msg/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fetchJson(`doc/${key}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({hash: blob.hash, size: blob.size}),
  });

  // read entries back - poll this on an interval for something "live"
  const entries = await fetchJson('doc?prefix=msg/&inline=1');
  // each entry: {key, hash, size, content} - content is the stored
  // bytes as text, present because inline=1 and the blob is small

If the user wants several independent rooms/threads rather than one
shared feed, mint a separate document per room (a bare POST /doc with no
ticket creates one; a ticket means "import an existing one" instead) and
keep a {namespace, ticket} pointer to it under this site's own
`topics/<name>` key, then address that room's own document explicitly by
namespace for its own entries:

  const params = new URLSearchParams({name: roomName, listed: '0'});
  const {namespace, write_ticket} = await fetchJson(`doc?${params}`, {method: 'POST'});
  const pointerBlob = await fetchJson('blob', {
    method: 'POST', body: JSON.stringify({namespace, ticket: write_ticket}),
  });
  await fetchJson(`doc/topics/${encodeURIComponent(roomName)}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({hash: pointerBlob.hash, size: pointerBlob.size}),
  });

  function documentsUrl(namespace, path) {
    return new URL(`/documents/${namespace}/${path}`, window.location.origin).toString();
  }
  // then read/write that room's own msg/* entries via documentsUrl(namespace, ...)
  // in place of the plain paths in the simple case above
"""

# Appended to the user's own message on every /chat turn (not folded into
# SYSTEM_PROMPT, deliberately - this needs to read as part of what the user
# just asked, so the model treats "parse this out into short tasks" as one
# of the things it's now been asked to do, not a standing background rule
# it can quietly deprioritize). Exists because a long turn (many tool
# iterations, or one slow generation) previously showed nothing more
# specific than a generic "thinking" line the whole time - indistinguishable
# from a genuinely hung sandbox. Instructing the model to narrate its own
# real subtasks, in its own words, gives the polling "Nobody says..." line
# actual content instead of a canned phrase repeating unchanged.
TASK_STATUS_INSTRUCTIONS = """

Before doing anything else this turn - including before you finish acting \
on these very instructions - say so: your first status line should \
announce that you're planning the work. Then break the work needed to \
satisfy the request above into a short sequence of subtasks, each about \
one minute of your own effort (a small edit is often only one or two \
subtasks - don't invent extra ones just to pad the count).

For EVERY subtask, including the first:
  - Write one short status line, third person, in the voice "Nobody is \
<doing something>." or "Nobody just <did something>.", on its own line, \
BEFORE calling any tools for that subtask.
  - Do the subtask's work (its tool calls).
  - Write one more such line noting what you just finished, before moving \
on to the next subtask.

These status lines are progress narration, not your answer to the user - \
keep each one to one short sentence. Once every subtask is done, give your \
normal final reply WITHOUT repeating this narration in it.
"""

SYSTEM_PROMPT = (
    "You are building a small static website for a user, one file at a "
    "time, using the read_file and write_file tools. You may only read or "
    "write these files: index.html, styles.css, client.js, chat-widget.js, "
    "payment-widget.js - there is no other filesystem access. chat-widget.js "
    "and payment-widget.js are ready-made, already-styled components (see "
    "below) - read one before editing it, and prefer using it as-is over "
    "writing chat or payment UI from scratch. Keep "
    "the site self-contained. Make small, "
    "incremental edits in response to each user request rather than "
    "rewriting everything each turn. When you believe the site satisfies "
    "the user's request, say so in your reply, but do not publish it "
    "yourself - only the user can do that."
    + CHASSIS_REFERENCE
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
    "name": None,  # set by /publish; stays None if budget ran out first
    # {"phase": "thinking"} or {"phase": "read_file"|"write_file", "path": ...}
    # while a /chat turn is in progress; None the rest of the time. Polled by
    # the page's own fast interval during a turn to show a "Nobody says..."
    # line - see NOBODY_SAYINGS in INDEX_PAGE.
    "activity": None,
    # Wall-clock time of this session's first real request - deliberately
    # NOT set here at module level. The active Tenki template is a
    # memory-snapshot one: this whole module only ever actually executes
    # once, at template BUILD time: every real session is a restored copy
    # of that exact frozen process memory, so a value set here would be the
    # build's own timestamp in every session, not that session's real
    # start. Set lazily instead, in _ensure_session_start() below, the
    # first time any request actually lands in a given restored copy - this
    # correctly gives each session its own real start time regardless of
    # when the template was built.
    "session_start": None,
}


def _ensure_session_start() -> None:
    with _lock:
        if _state["session_start"] is None:
            _state["session_start"] = time.time()


def _time_remaining_pct() -> float:
    with _lock:
        start = _state["session_start"]
    if start is None:
        return 100.0
    elapsed = time.time() - start
    return max(0.0, 100.0 * (1 - elapsed / SESSION_MAX_LIFETIME_SECS))


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
        _state["messages"].append(
            {"role": "user", "content": user_message + TASK_STATUS_INSTRUCTIONS}
        )
        messages = list(_state["messages"])

    final_text = ""
    budget_exhausted = False
    # The model's own narration of its current subtask (see
    # TASK_STATUS_INSTRUCTIONS), shown in place of the generic canned
    # phrases once it starts arriving - carried forward across both the
    # (near-instant) tool-execution gap and the next, possibly slow,
    # generation, until replaced by newer narration.
    last_status_text = None
    try:
        for _ in range(MAX_TOOL_ITERATIONS):
            with _lock:
                _state["activity"] = (
                    {"phase": "status", "text": last_status_text}
                    if last_status_text
                    else {"phase": "thinking"}
                )
            response = client.messages.create(
                model=MODEL,
                max_tokens=4096,
                # Cached: SYSTEM_PROMPT is identical on every turn of a session
                # and grew substantially once CHASSIS_REFERENCE was added - the
                # cost formula below already accounted for cache pricing, this
                # is what actually turns it on.
                system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
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

            status_text = final_text.strip()
            if status_text:
                last_status_text = status_text
                with _lock:
                    _state["activity"] = {"phase": "status", "text": last_status_text}

            tool_results = []
            for block in response.content:
                if block.type != "tool_use":
                    continue
                with _lock:
                    _state["activity"] = (
                        {"phase": "status", "text": last_status_text}
                        if last_status_text
                        else {"phase": block.name, "path": block.input.get("path")}
                    )
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
    finally:
        # Always cleared, even if client.messages.create raised - otherwise
        # a failed turn would leave a stale "Nobody is ..." line showing
        # forever, since nothing else would ever set activity back to None.
        with _lock:
            _state["activity"] = None

    # _time_remaining_pct() takes _lock itself - computed before entering
    # the block below, since Lock isn't reentrant.
    time_remaining_pct = _time_remaining_pct()
    with _lock:
        _state["messages"] = messages
        return {
            "reply": final_text,
            "status": _state["status"],
            "cost_usd": _state["cost_usd"],
            "budget_usd": BUDGET_USD,
            "time_remaining_pct": time_remaining_pct,
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
  #status-bar { font-size: 12px; color: #666; margin-bottom: 4px; }
  #nobody-says { font-size: 12px; color: #888; font-style: italic; min-height: 1.4em; margin-bottom: 8px; }
  #toast { font-size: 12px; background: #fff3cd; border: 1px solid #e0c46c; border-radius: 4px; padding: 6px 10px; margin-bottom: 8px; display: none; }
  textarea { width: 100%; box-sizing: border-box; }
  #preview-buttons { display: flex; gap: 8px; margin-top: 6px; }
  #preview-buttons button { flex: 1; }
  button { margin-top: 6px; }
  #publish-row { display: flex; gap: 8px; margin-top: 6px; }
  #app-name { flex: 1; box-sizing: border-box; }
  #publish-btn { background: #0a5; color: white; border: none; padding: 8px; cursor: pointer; margin-top: 0; }
  #publish-btn:disabled { background: #999; cursor: default; }
</style>
</head>
<body>
<div id="chat-pane">
  <div id="status-bar">status: <span id="status">building</span></div>
  <div id="toast"></div>
  <div id="nobody-says"></div>
  <div id="log"></div>
  <div id="preview-buttons">
    <button id="preview-computer-btn">Preview (Computer)</button>
    <button id="preview-mobile-btn">Preview (Mobile)</button>
  </div>
  <textarea id="input" rows="3" placeholder="Describe what you want..."></textarea>
  <button id="send-btn">Send</button>
  <div id="publish-row">
    <input id="app-name" type="text" placeholder="App name">
    <button id="publish-btn">Import</button>
  </div>
</div>
<script>
const log = document.getElementById('log');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const publishBtn = document.getElementById('publish-btn');
const nameInput = document.getElementById('app-name');
const statusEl = document.getElementById('status');
const nobodySaysEl = document.getElementById('nobody-says');
const toastEl = document.getElementById('toast');

// Whimsical stand-ins for a plain "working..." spinner while a /chat turn
// is in progress - several variants per phase, picked at random on each
// fast poll tick so it feels alive rather than static. {path} is filled in
// for the file-tool phases.
const NOBODY_SAYINGS = {
  thinking: [
    "Nobody knows the answer yet - give it a moment.",
    "Nobody rushes a good decision.",
    "Nobody is turning that over.",
    "Nobody has a plan. Just a sec.",
  ],
  read_file: [
    "Nobody is reading {path}.",
    "Nobody just took a look at {path}.",
    "Nobody double-checked {path}.",
  ],
  write_file: [
    "Nobody is writing to {path}.",
    "Nobody just updated {path}.",
    "Nobody put some finishing touches on {path}.",
  ],
};

function nobodySaying(activity) {
  if (!activity) return '';
  // "status" is the model's own real-time narration of its current subtask
  // (see TASK_STATUS_INSTRUCTIONS in harness.py) - shown verbatim in place
  // of a canned phrase, since it's more specific and proves the model is
  // actually making progress rather than stuck.
  if (activity.phase === 'status') return activity.text || '';
  const variants = NOBODY_SAYINGS[activity.phase] || NOBODY_SAYINGS.thinking;
  const template = variants[Math.floor(Math.random() * variants.length)];
  return template.replace('{path}', activity.path || '');
}

// Budget/time reminders: no persistent dollar figure or countdown shown at
// all - just a transient reminder, self-removed 10s after it appears, the
// first time either resource's remaining percentage crosses down through
// 50%, 25%, or 10%. Tracked per threshold per resource so each only ever
// fires once per session (page load). Checked from two places: the 5s
// refreshStatus() poll (a safety net - e.g. while idle, time still ticks
// down), and directly off the /chat response the instant a reply lands
// (tokens only actually change when the model has returned with
// something, so that's the real event to react to, not a fixed timer).
const THRESHOLDS = [50, 25, 10];
const tokenThresholdsShown = new Set();
const timeThresholdsShown = new Set();
let toastTimer = null;

function showToast(message) {
  toastEl.textContent = message;
  toastEl.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 10000);
}

function checkThresholds(costUsd, budgetUsd, timeRemainingPct) {
  if (!budgetUsd) return;
  const tokenPct = Math.max(0, Math.round(100 * (1 - costUsd / budgetUsd)));
  const timePct = Math.max(0, Math.round(timeRemainingPct));
  let crossed = false;
  for (const threshold of THRESHOLDS) {
    if (tokenPct <= threshold && !tokenThresholdsShown.has(threshold)) {
      tokenThresholdsShown.add(threshold);
      crossed = true;
    }
    if (timePct <= threshold && !timeThresholdsShown.has(threshold)) {
      timeThresholdsShown.add(threshold);
      crossed = true;
    }
  }
  if (crossed) {
    showToast(`Heads up - about ${tokenPct}% of tokens and ${timePct}% of time remain.`);
  }
}

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
  checkThresholds(j.cost_usd, j.budget_usd, j.time_remaining_pct);
  const disabled = j.status !== 'building';
  input.disabled = disabled;
  sendBtn.disabled = disabled;
  publishBtn.disabled = disabled;
  nameInput.disabled = disabled;
  if (j.name && !nameInput.value) nameInput.value = j.name;
  return j;
}

// Polls /status quickly while a /chat turn is in flight, purely to render
// NOBODY_SAYINGS from the backend's current activity - independent of, and
// much faster than, the 5s refreshStatus() interval below.
async function pollActivity() {
  try {
    const r = await fetch('/status');
    const j = await r.json();
    nobodySaysEl.textContent = nobodySaying(j.activity);
  } catch (err) {
    // A transient failure here just means one blank tick - not worth
    // interrupting the chat request itself over.
  }
}

async function send() {
  const message = input.value.trim();
  if (!message) return;
  addMsg('user', message);
  input.value = '';
  sendBtn.disabled = true;
  nobodySaysEl.textContent = nobodySaying({phase: 'thinking'});
  const activityTimer = setInterval(pollActivity, 1200);
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
      // Checked right here, off this response's own numbers, rather than
      // waiting for the next poll - tokens only actually change when the
      // model has just returned with something, so this is the real event
      // to react to.
      checkThresholds(j.cost_usd, j.budget_usd, j.time_remaining_pct);
      refreshPreview();
    }
  } finally {
    clearInterval(activityTimer);
    nobodySaysEl.textContent = '';
    await refreshStatus();
  }
}

publishBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name) {
    alert('Give the app a name first.');
    nameInput.focus();
    return;
  }
  publishBtn.disabled = true;
  nameInput.disabled = true;
  const r = await fetch('/publish', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({name}),
  });
  if (!r.ok) {
    alert('Import failed: ' + (await r.text()));
    publishBtn.disabled = false;
    nameInput.disabled = false;
    return;
  }
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
        _ensure_session_start()
        path = urlparse(self.path).path
        if path == "/":
            self._send_html(INDEX_PAGE)
        elif path == "/status":
            # _time_remaining_pct() takes _lock itself - computed before
            # entering this block, since Lock isn't reentrant.
            time_remaining_pct = _time_remaining_pct()
            with _lock:
                self._send_json(
                    {
                        "status": _state["status"],
                        "cost_usd": _state["cost_usd"],
                        "budget_usd": BUDGET_USD,
                        "name": _state["name"],
                        "activity": _state["activity"],
                        "time_remaining_pct": time_remaining_pct,
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
        _ensure_session_start()
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
            name = (payload.get("name") or "").strip()
            if not name:
                self._send_json({"error": "name required"}, status=400)
                return
            with _lock:
                _state["name"] = name
                if _state["status"] != "budget_exhausted":
                    _state["status"] = "published"
                status, cost = _state["status"], _state["cost_usd"]
            self._send_json({"status": status, "cost_usd": cost, "name": name})
        else:
            self._send_json({"error": "not found"}, status=404)


def main():
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"harness listening on :{PORT}", file=sys.stderr)
    server.serve_forever()


if __name__ == "__main__":
    main()
