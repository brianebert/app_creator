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
// 1. Private feed (default - just pass topicName, nothing else). Every copy
//    of this exact imported app shares one private chat automatically - no
//    setup, no ticket, and it isn't tied to chat.js or any particular
//    sidecar. This works because chassis mints a dedicated chat-topic
//    document for every generated app at creation time and records a
//    {namespace, secret} pointer under a self-declared `chat.private-topic`
//    key on the app's own document (see PRIVATE_CHAT_TOPIC_KEY/
//    mint_private_chat_topic in chassis's main.rs) - since every copy of one
//    *imported* app is the same synced document, this key (and so this
//    conversation) is the same everywhere that app ends up, with no publish
//    step required. `ensureTopic()` below reads that key and joins the
//    pointed-to topic via chassis's `/doc?secret=...` (no ticket, no stored
//    node address - see that endpoint's own doc comment for why). Only an
//    app whose own document predates this feature (or was created some
//    other way) falls back to the old behavior: mints its own throwaway
//    document, private to this one page, the first time anyone sends a
//    message. Once this app is published, the platform reuses this exact
//    document as its chat.js-visible topic too (same `request_chat_topic_
//    registration`, now reusing `chat.private-topic` instead of minting a
//    second, disconnected document) - so this default conversation and the
//    one visible in chat.js end up being the same one, automatically.
//
// 2. Join a DIFFERENT existing topic - pass `namespace` AND `writeTicket`
//    for a topic that already exists elsewhere (for example, one the user
//    made through the standalone chat app's own "New Topic" button, for a
//    cross-site shared thread unrelated to this app's own conversation).
//    This makes the widget show and post into that exact same live
//    conversation instead of this app's own default one.
function mountChatTopic(container, options) {
  options = options || {};
  const topicName = options.topicName || 'chat';
  const senderStorageKey = options.senderStorageKey || 'chat-sender-name';
  const fixedSender = options.fixedSender || null;

  injectStylesOnce();

  // The page is always loaded at its own mount root (by name, or by
  // /documents/<namespace>/) and never at a sibling filename - true for
  // every site this harness builds, since it only ever produces one HTML
  // file and chassis serves it AT the bare mount path, never at a literal
  // trailing /index.html. Do NOT copy this pathPrefix() into a multi-page
  // app, where that's no longer true (confirmed live on the "Elect
  // Nobody" app, which is multi-page - its chat broke exactly this way
  // until fixed with a mount-name-aware version instead of this
  // position-based one).
  //
  // Given the assumption above, the whole path - not the path minus its
  // last segment - IS the prefix: there is no filename segment to drop.
  // An earlier version of this function dropped the last segment anyway
  // (a leftover from treating this like a multi-segment asset path),
  // which silently deleted the one and only segment - the mount name
  // itself - for the single most common way anyone reaches a real app
  // (its own bare /<name> URL). Confirmed live as the actual cause of
  // payment-widget.js 404ing on every call for a real, normally-viewed
  // app, not the narrower /documents/<namespace>/... case a previous fix
  // addressed.
  function pathPrefix() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    return segments.length ? `/${segments.join('/')}` : '';
  }

  function absoluteUrl(path) {
    return new URL(`${pathPrefix()}/${path}`, window.location.origin).toString();
  }

  // Whatever a reverse proxy in front of this sidecar stripped (e.g.
  // '/apps' on nobody.news) - everything in the current URL BEFORE this
  // app's own mount segment(s), never including them. Needed for a bare,
  // app-agnostic route (stats.json) and for addressing a DIFFERENT
  // namespace's document (documentsUrl below) - pathPrefix() would wrongly
  // mix this app's own name/namespace into either.
  function proxyPrefix() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    const docsIndex = segments.indexOf('documents');
    const proxySegments = docsIndex !== -1 ? segments.slice(0, docsIndex) : segments.slice(0, -1);
    return proxySegments.length ? `/${proxySegments.join('/')}` : '';
  }

  // GET /stats.json is a bare, sidecar-level route (this sidecar's own
  // stats, not this app's) - unlike doc/blob, it is NOT namespace-scoped,
  // so it must be called through the reverse-proxy prefix only, never
  // this app's own mount prefix.
  function bareUrl(path) {
    return new URL(`${proxyPrefix()}/${path}`, window.location.origin).toString();
  }

  // A second, independent way to reach this app's own mount prefix
  // (pathPrefix() above is the other) - strips a trailing filename or
  // slash rather than counting segments. Both are correct and should
  // agree; kept separate rather than unified to avoid touching working,
  // unrelated code while fixing proxyPrefix()/documentsUrl() above. Safe
  // because every app this harness builds is single-page: the current
  // path, minus a trailing `index.html` filename or trailing slash, is
  // just this app's own mount root either way it was reached (`/<name>/`
  // or `/documents/<namespace>/`).
  function ownAppPrefix() {
    let path = window.location.pathname;
    if (path.endsWith('/index.html')) path = path.slice(0, -'index.html'.length);
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path === '/' ? '' : path;
  }

  function ownAppUrl(path) {
    return new URL(`${ownAppPrefix()}/${path}`, window.location.origin).toString();
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
    const stats = await fetchJson(bareUrl('stats.json'));
    mySidecarEndpointId = stats.endpoint_id;
  }

  // Reads this app's own `chat.private-topic` pointer (if any) and joins it
  // via chassis's secret-only /doc join, no ticket involved - see the mode-1
  // doc comment above. Read-only and cheap when the key is absent (just one
  // GET against this app's own document), so it's safe to call eagerly at
  // page load, before anyone has sent a message - unlike ensureTopic()'s
  // fallback mint below, this never creates anything of its own. Returns
  // whether a topic was actually joined.
  async function tryJoinPrivateChatTopic() {
    if (namespace) return true;
    try {
      const entries = await fetchJson(ownAppUrl('doc?prefix=chat.private-topic&inline=1'));
      const entry = entries[0];
      if (!entry || !entry.content) return false;
      const pointer = JSON.parse(entry.content);
      const params = new URLSearchParams({
        secret: pointer.secret,
        name: 'private-chat',
        listed: '0',
      });
      const joined = await fetchJson(absoluteUrl(`doc?${params}`), { method: 'POST' });
      namespace = joined.namespace;
      writeTicket = joined.write_ticket;
      return true;
    } catch (error) {
      console.error('private chat-topic lookup failed, falling back to a page-local topic', error);
      return false;
    }
  }

  // Joins this app's shared private topic if it has one; otherwise mints an
  // isolated, page-local document the first time this page actually needs
  // one (the old behavior) - only reached for an app whose own document
  // predates this feature. Idempotent either way: once `namespace` is set,
  // later calls are a no-op.
  async function ensureTopic() {
    if (await tryJoinPrivateChatTopic()) return;
    const params = new URLSearchParams({ name: topicName, listed: '0' });
    const created = await fetchJson(absoluteUrl(`doc?${params}`), { method: 'POST' });
    namespace = created.namespace;
    writeTicket = created.write_ticket;
  }

  // Addresses a DIFFERENT namespace's document (the cross-topic mode's own
  // topic, not this app's) - needs proxyPrefix(), not pathPrefix(): this
  // app's own mount name/namespace has no business in a /documents/<ns>/
  // path for a namespace that isn't it. Confirmed via chassis's own
  // document_route_path, which requires '/documents/' to be the literal
  // start of the path it's matching against - prepending this app's own
  // mount segment(s) in front of it (what absoluteUrl()/pathPrefix()
  // would do) made every call here fail to resolve at all, in both the
  // plain and reverse-proxied cases.
  function documentsUrl(path) {
    return new URL(`${proxyPrefix()}/documents/${namespace}/${path}`, window.location.origin).toString();
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
  // Eager, read-only attempt at page load (not just lazily on first send):
  // a shared topic is pointless if other visitors' messages stay invisible
  // until you post one yourself. Safe for the old per-page-mint fallback
  // too - tryJoinPrivateChatTopic() never mints anything on its own, so an
  // app without a chat.private-topic key just resolves to false here and
  // loadMessages() below no-ops until sendMessage() eventually mints one.
  (namespace ? joinExistingTopic() : tryJoinPrivateChatTopic())
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
