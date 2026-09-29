// Ready-made chat-topic widget, styled to look identical to the standalone
// chat app's own message bubbles (same colors, same speech-bubble tails,
// same self/other logic) - extracted from the "Elect Nobody" campaign
// app's embedded chat and generalized so any generated site can drop in a
// chat feature that looks like a native part of this platform, not a
// bespoke reskin.
//
// Usage - add one container element and one script tag to index.html:
//
//   <div id="chat"></div>
//   <script src="chat-widget.js"></script>
//   <script>
//     mountChatTopic(document.getElementById('chat'), {
//       topicName: 'general',
//     });
//   </script>
//
// Two modes, chosen by what you pass:
//
// 1. Private feed (default - just pass topicName, nothing else). Mints a
//    brand-new document of its own the first time anyone sends a message,
//    scoped to this app - a guestbook, comment thread, or single chat room
//    that lives only on this site. This is the only mode a generated app
//    can use on its own; it needs no ticket and no setup step.
//
// 2. Join an existing topic - pass `namespace` AND `writeTicket` for a
//    topic that already exists (for example, one the user created earlier
//    through the standalone chat app's own "New Topic" button). This makes
//    the widget show and post into that exact same live conversation -
//    useful when the user wants this page and the chat app to share one
//    thread. A generated app cannot mint a *new* topic that chat.js itself
//    will also discover (that requires a write ticket to chat's own
//    document, which this platform does not hand out to generated apps) -
//    if the user wants that, they need to create the topic in the chat app
//    first and give you its namespace/ticket (visible via that topic's own
//    share/ticket action), then pass them here.
function mountChatTopic(container, options) {
  options = options || {};
  const topicName = options.topicName || 'chat';
  const senderStorageKey = options.senderStorageKey || 'chat-sender-name';
  const fixedSender = options.fixedSender || null;

  injectStylesOnce();

  // This assumes the page is always loaded at its own mount root (by name,
  // or by /documents/<hash>/) and never at a sibling filename - true for
  // every site this harness builds, since it only ever produces one HTML
  // file. Do NOT copy this pathPrefix() into a multi-page app: dropping the
  // trailing path segment breaks the moment a real second page exists and
  // links to this one by filename (confirmed live on the "Elect Nobody"
  // app, which is multi-page - its chat broke exactly this way until fixed
  // with a mount-name-aware version instead of this position-based one).
  function pathPrefix() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    const docsIndex = segments.indexOf('documents');
    const prefixSegments = docsIndex !== -1 ? segments.slice(0, docsIndex) : segments.slice(0, -1);
    return prefixSegments.length ? `/${prefixSegments.join('/')}` : '';
  }

  function absoluteUrl(path) {
    return new URL(`${pathPrefix()}/${path}`, window.location.origin).toString();
  }

  async function fetchJson(url, opts) {
    const response = await fetch(url, opts);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
  }

  container.innerHTML =
    '<ul class="chat-widget-messages"></ul>' +
    '<form class="chat-widget-form" autocomplete="off">' +
    '<input class="chat-widget-sender" type="text" placeholder="Your name" />' +
    '<input class="chat-widget-text" type="text" placeholder="Message" required />' +
    '<button type="submit">Send</button>' +
    '</form>' +
    '<p class="chat-widget-status" hidden></p>';
  const messagesEl = container.querySelector('.chat-widget-messages');
  const form = container.querySelector('.chat-widget-form');
  const senderEl = container.querySelector('.chat-widget-sender');
  const textEl = container.querySelector('.chat-widget-text');
  const statusEl = container.querySelector('.chat-widget-status');

  if (fixedSender) {
    senderEl.value = fixedSender;
    senderEl.disabled = true;
  } else {
    senderEl.value = localStorage.getItem(senderStorageKey) || '';
  }

  function setStatus(message) {
    statusEl.textContent = message;
    statusEl.hidden = !message;
  }

  let namespace = options.namespace || null;
  let writeTicket = options.writeTicket || null;
  let mySidecarEndpointId = null;

  async function fetchMyEndpointId() {
    const stats = await fetchJson(absoluteUrl('stats.json'));
    mySidecarEndpointId = stats.endpoint_id;
  }

  // Mints a private, single-purpose document the first time this page
  // actually needs one - same primitive as the standalone-feed pattern
  // (a bare POST /doc with no ticket creates a new document). Idempotent:
  // once `namespace` is set, later calls are a no-op.
  async function ensureTopic() {
    if (namespace) return;
    const params = new URLSearchParams({ name: topicName, listed: '0' });
    const created = await fetchJson(absoluteUrl(`doc?${params}`), { method: 'POST' });
    namespace = created.namespace;
    writeTicket = created.write_ticket;
  }

  function documentsUrl(path) {
    return absoluteUrl(`documents/${namespace}/${path}`);
  }

  // Ensures this sidecar has actually joined an existing topic's namespace
  // before reading/writing it (only relevant in "join an existing topic"
  // mode - a no-op otherwise). Idempotent and cheap, safe to call before
  // every send rather than trusting a one-time page-load join to have
  // succeeded.
  async function joinExistingTopic() {
    if (!writeTicket) return;
    const params = new URLSearchParams({
      name: `topic-${topicName}`,
      ticket: writeTicket,
      skip_shape_detection: '1',
      listed: '0',
    });
    await fetch(absoluteUrl(`doc?${params}`), { method: 'POST' });
  }

  const MAX_RENDERED = 50;
  let cursorKey = null;
  let loadedMessages = [];
  let loading = false;

  function render() {
    const messages = loadedMessages
      .slice()
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .slice(-MAX_RENDERED);
    messagesEl.innerHTML = '';
    for (const message of messages) {
      const li = document.createElement('li');
      li.className = message.author === mySidecarEndpointId ? 'self' : 'other';
      const sender = document.createElement('span');
      sender.className = 'sender';
      sender.textContent = message.sender || 'anonymous';
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = message.ts ? new Date(message.ts).toLocaleTimeString() : '';
      const text = document.createElement('div');
      text.textContent = message.text || '';
      li.appendChild(sender);
      li.appendChild(time);
      li.appendChild(text);
      messagesEl.appendChild(li);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function loadMessages() {
    if (!namespace || loading) return;
    loading = true;
    try {
      const path = cursorKey
        ? `doc?prefix=msg/&inline=1&after=${encodeURIComponent(cursorKey)}`
        : `doc?prefix=msg/&inline=1&last=${MAX_RENDERED}`;
      const entries = await fetchJson(documentsUrl(path));
      for (const entry of entries) {
        // Don't advance past an entry whose content hasn't arrived yet from
        // a peer - leave it as the next "after" so the next poll asks again.
        if (!entry.content) break;
        cursorKey = entry.key;
        try {
          loadedMessages.push({ ...JSON.parse(entry.content), author: entry.author, key: entry.key });
        } catch (error) {
          console.error('skipping unparseable message', entry.key, error);
        }
      }
      if (loadedMessages.length > MAX_RENDERED * 2) {
        loadedMessages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        loadedMessages = loadedMessages.slice(-MAX_RENDERED * 2);
      }
      render();
    } finally {
      loading = false;
    }
  }

  async function sendMessage(text) {
    await ensureTopic();
    await joinExistingTopic();
    const sender = fixedSender || senderEl.value.trim() || 'anonymous';
    if (!fixedSender) localStorage.setItem(senderStorageKey, sender);
    const body = JSON.stringify({ sender, ts: Date.now(), text });
    const blob = await fetchJson(documentsUrl('blob'), { method: 'POST', body });
    const key = `msg/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fetchJson(documentsUrl(`doc/${key}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash: blob.hash, size: blob.size }),
    });
    await loadMessages();
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = textEl.value.trim();
    if (!text) return;
    setStatus('Sending...');
    sendMessage(text)
      .then(() => {
        textEl.value = '';
        setStatus('');
      })
      .catch((error) => {
        console.error('send message failed', error);
        setStatus(`Message not sent - ${error.message}. Click Send to retry.`);
      });
  });

  const ACTIVE_POLL_MS = 1500;
  const IDLE_POLL_MS = 8000;
  let pollTimer = null;
  function pollIntervalMs() {
    return document.visibilityState === 'visible' ? ACTIVE_POLL_MS : IDLE_POLL_MS;
  }
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(
      () => loadMessages().catch((error) => console.error('poll failed', error)),
      pollIntervalMs()
    );
  }
  document.addEventListener('visibilitychange', startPolling);

  // Fire-and-forget startup, each step with its own .catch() - a transient
  // failure in any one of these (e.g. this sidecar's stats.json briefly
  // unavailable) must not prevent polling from starting, or the widget can
  // wedge in "unavailable" for the rest of the page's life with no way to
  // self-heal once the underlying issue clears.
  fetchMyEndpointId().catch((error) => console.error('fetch own endpoint id failed', error));
  (namespace ? joinExistingTopic() : Promise.resolve())
    .then(loadMessages)
    .catch((error) => console.error('initial load failed', error));
  startPolling();
}

// Injected once, scoped under .chat-widget-messages/.chat-widget-form/
// .chat-widget-status so this drops into any page's own stylesheet without
// id collisions - values copied directly from the standalone chat app's
// own chat.css, not reproduced from memory, so a widget embedded this way
// is visually identical to a real chat app topic.
function injectStylesOnce() {
  if (document.getElementById('chat-widget-styles')) return;
  const style = document.createElement('style');
  style.id = 'chat-widget-styles';
  style.textContent = `
.chat-widget-messages {
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0.5rem 0.9rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  max-height: 24rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  background: #fff;
  font-family: system-ui, sans-serif;
}
.chat-widget-messages li {
  position: relative;
  z-index: 0;
  margin: 0 0 0.7rem;
  overflow-wrap: anywhere;
  max-width: 75%;
  padding: 0.4rem 0.6rem;
  border-radius: 1.1rem;
}
.chat-widget-messages li.self {
  align-self: flex-end;
  background: #0a7cff;
  color: #fff;
}
.chat-widget-messages li.other {
  align-self: flex-start;
  background: #e5e5ea;
  color: #000;
}
.chat-widget-messages li.self::before {
  content: "";
  position: absolute;
  z-index: -1;
  right: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  background: #0a7cff;
}
.chat-widget-messages li.self::after {
  content: "";
  position: absolute;
  z-index: -1;
  top: 100%;
  left: calc(100% - 6px);
  width: 16px;
  height: 18px;
  background: #0a7cff;
  clip-path: path("M0,0 L6,0 C7,4 9,7 11,9 C9,7 4,4 0,2 Z");
}
.chat-widget-messages li.other::before {
  content: "";
  position: absolute;
  z-index: -1;
  left: 0;
  bottom: 0;
  width: 18px;
  height: 18px;
  background: #e5e5ea;
}
.chat-widget-messages li.other::after {
  content: "";
  position: absolute;
  z-index: -1;
  top: 100%;
  right: calc(100% - 6px);
  width: 16px;
  height: 18px;
  background: #e5e5ea;
  clip-path: path("M16,0 L10,0 C9,4 7,7 5,9 C7,7 12,4 16,2 Z");
}
.chat-widget-messages .sender { font-weight: 600; }
.chat-widget-messages li.self .time {
  color: rgba(255, 255, 255, 0.75);
  font-size: 0.8rem;
  margin-left: 0.5rem;
}
.chat-widget-messages li.other .time {
  color: #666;
  font-size: 0.8rem;
  margin-left: 0.5rem;
}
.chat-widget-form { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
.chat-widget-form input { flex: 1; padding: 0.4rem; font: inherit; }
.chat-widget-status { color: #a00; font-size: 0.85rem; margin: 0 0 0.5rem; }
`;
  document.head.appendChild(style);
}
