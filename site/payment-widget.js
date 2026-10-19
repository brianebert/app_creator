// Ready-made "pay with crypto" widget - the same real, independently
// verified USDC-on-testnet payment flow shipped on the platform's own
// /create-app page, generalized so any generated site can charge its own
// price to its own wallet. Chassis still submits (Stellar) or polls
// (EVM) the transaction and independently checks the real on-chain effect
// before telling this widget the payment is good - it never trusts the
// wallet's or this page's own claim.
//
// Price and destination are NOT passed here as options - they live on the
// app's own document at pricing/<itemId> (the one place chassis itself
// trusts for what an item costs and where it's paid; see
// read_pricing_entry/[[project_payment_destination_spoofing_todo]] for why
// a client-supplied destination was never safe to verify against). Set it
// once via the same generic blob+doc primitives used for topics.watch:
//
//   HASH=$(curl -s -X POST "$HOST/<app>/blob" --data-binary \
//     '{"amount_usd": 5, "description": "One month of premium", \
//       "destination": {"stellar": "G...", "evm": "0x..."}}' | jq -r .hash)
//   curl -X POST "$HOST/<app>/doc/pricing/premium" \
//     -H "Content-Type: application/json" -d "{\"hash\":\"$HASH\",\"size\":...}"
//
// Usage - add one container element and one script tag to index.html:
//
//   <div id="pay"></div>
//   <script src="payment-widget.js"></script>
//   <script>
//     mountPaymentWidget(document.getElementById('pay'), {
//       itemId: 'premium',   // matches pricing/premium on this app's doc
//       onPaid(receipt) {
//         // receipt = { verified, chain, network, destination, asset,
//         //             amount_usd, tx_hash, receipt }
//         // Called once chassis has independently confirmed the payment.
//         // This page decides what "paid" unlocks - there is no chassis-
//         // side session to start (that's /create-app's own thing, not
//         // this component's). Persisting `receipt` into your own app's
//         // document (e.g. as a doc entry) is a reasonable way to keep
//         // durable, tamper-evident proof of payment, since it's signed by
//         // this sidecar's own key.
//       },
//     });
//   </script>
//
// Only the chains pricing/<itemId>'s own destination covers are offered.
// Every network this sidecar knows about is fetched live from
// `GET /payment/networks` (the same data-driven pattern /create-app's own
// page uses), so a new network or token shows up automatically without any
// change here.
//
// Testnet only, same as /create-app - real receiving addresses, fake
// money. Users pay their own network fee; there is no fee sponsorship yet.
function mountPaymentWidget(container, options) {
  options = options || {};
  const itemId = options.itemId;
  const onPaid = typeof options.onPaid === 'function' ? options.onPaid : () => {};
  if (!itemId) {
    throw new Error('mountPaymentWidget requires options.itemId (matching a pricing/<itemId> doc entry)');
  }
  let amountUsd, destinations, description;

  injectStylesOnce();

  // The "drop the last path segment, it's a filename" idea this used to
  // use (still correct for a page like chassis's own /pricing admin page)
  // does not apply here: chassis serves this harness's index.html AT the
  // bare mount path, never at a literal trailing /index.html, so there is
  // no filename segment in window.location.pathname to drop - the whole
  // path (mount name, or 'documents'+namespace, or a reverse-proxy prefix
  // in front of either) IS the prefix. Dropping the last segment of
  // /life.10 or /life.10/ was deleting the one and only segment - the
  // mount name itself - confirmed live as the cause of every fetch from
  // this widget 404ing against a real, normally-reached app (not the
  // /documents/<namespace>/... form a previous, narrower fix addressed).
  function pathPrefix() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    return segments.length ? `/${segments.join('/')}` : '';
  }

  function absoluteUrl(path) {
    return new URL(`${pathPrefix()}/${path}`, window.location.origin).toString();
  }

  // Whatever a reverse proxy in front of this sidecar stripped (e.g.
  // '/apps' on nobody.news) - everything in the current URL BEFORE this
  // app's own mount segment(s), never including them. A bare,
  // app-agnostic route needs exactly this, not pathPrefix(): hardcoding
  // an empty prefix here would work directly against a sidecar but drop
  // a real reverse-proxy prefix, 404ing there instead - the same mistake
  // pathPrefix() used to make for namespace-scoped calls, just for the
  // opposite kind of route.
  function proxyPrefix() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    const docsIndex = segments.indexOf('documents');
    const proxySegments = docsIndex !== -1 ? segments.slice(0, docsIndex) : segments.slice(0, -1);
    return proxySegments.length ? `/${proxySegments.join('/')}` : '';
  }

  // GET /payment/networks is deliberately a bare, app-agnostic route on
  // every sidecar (same network/token list regardless of which app asks)
  // - unlike doc/blob/payment-verify, it is NOT namespace-scoped, so it
  // must be called through the reverse-proxy prefix only, never this
  // app's own mount prefix.
  function bareUrl(path) {
    return new URL(`${proxyPrefix()}/${path}`, window.location.origin).toString();
  }

  async function fetchJson(url, opts) {
    const response = await fetch(url, opts);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  container.innerHTML =
    '<p class="payment-widget-description" hidden></p>' +
    '<label class="payment-widget-label">Pay with</label>' +
    '<select class="payment-widget-network"></select>' +
    '<select class="payment-widget-token"></select>' +
    '<p><button type="button" class="payment-widget-button" disabled>Loading payment options...</button></p>' +
    '<p class="payment-widget-status"></p>';
  const descriptionEl = container.querySelector('.payment-widget-description');
  const networkSelect = container.querySelector('.payment-widget-network');
  const tokenSelect = container.querySelector('.payment-widget-token');
  const payButton = container.querySelector('.payment-widget-button');
  const statusEl = container.querySelector('.payment-widget-status');

  function setStatus(message) {
    statusEl.textContent = message || '';
  }

  let networks = [];
  function currentNetwork() {
    return networks.find((n) => n.key === networkSelect.value);
  }
  function destinationFor(network) {
    return destinations[network.chain];
  }

  function populateTokens() {
    const network = currentNetwork();
    tokenSelect.innerHTML = '';
    for (const token of network.tokens) {
      const opt = document.createElement('option');
      opt.value = token;
      opt.textContent = token;
      tokenSelect.appendChild(opt);
    }
  }

  (async () => {
    try {
      const key = 'pricing/' + itemId;
      const entries = await fetchJson(absoluteUrl(`doc?prefix=${encodeURIComponent(key)}&inline=1`));
      const entry = entries.find((e) => e.key === key);
      if (!entry || !entry.content) {
        throw new Error(`no pricing/${itemId} entry found on this app's own document`);
      }
      const pricing = JSON.parse(entry.content);
      amountUsd = pricing.amount_usd;
      destinations = pricing.destination || {};
      description = pricing.description || '';
      if (description) {
        descriptionEl.hidden = false;
        descriptionEl.textContent = description;
      }

      const all = await fetchJson(bareUrl('payment/networks'));
      networks = all.networks.filter((n) => Boolean(destinationFor(n)));
      if (networks.length === 0) {
        throw new Error(`pricing/${itemId}'s destination has no chain this sidecar supports`);
      }
      networkSelect.innerHTML = '';
      for (const network of networks) {
        const opt = document.createElement('option');
        opt.value = network.key;
        opt.textContent = network.label;
        networkSelect.appendChild(opt);
      }
      populateTokens();
      payButton.textContent = `Connect wallet and pay $${amountUsd}`;
      payButton.disabled = false;
    } catch (err) {
      setStatus(`Could not load payment options - ${err.message}`);
    }
  })();
  networkSelect.addEventListener('change', populateTokens);

  // Loaded from a CDN as real ES modules - see /create-app's own page for
  // why Freighter's package is used directly instead of Stellar Wallets
  // Kit (a real, reproducible upstream loading bug in the kit's per-wallet
  // submodules as of this writing, not a guess).
  async function payOnStellar(network) {
    const destination = destinationFor(network);
    setStatus('Loading Stellar libraries...');
    const [sdk, freighterModule] = await Promise.all([
      import('https://cdn.jsdelivr.net/npm/@stellar/stellar-sdk@latest/+esm'),
      import('https://cdn.jsdelivr.net/npm/@stellar/freighter-api@latest/+esm'),
    ]);
    const { TransactionBuilder, Account, Asset, Operation, Networks, BASE_FEE } = sdk;
    const freighter = freighterModule.default;

    setStatus('Connecting to Freighter...');
    const access = await freighter.requestAccess();
    if (access.error) throw new Error(access.error.message || String(access.error));
    const address = access.address;

    setStatus('Building the payment transaction...');
    const accountResp = await fetch(network.horizon_base + '/accounts/' + address);
    if (!accountResp.ok) {
      throw new Error('could not load your Stellar testnet account - does it have a balance and a USDC trustline?');
    }
    const accountJson = await accountResp.json();
    const account = new Account(address, accountJson.sequence);
    const usdcAsset = new Asset('USDC', network.usdc_issuer);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.payment({
        destination,
        asset: usdcAsset,
        amount: String(amountUsd),
      }))
      .setTimeout(180)
      .build();

    setStatus('Approve the payment in Freighter...');
    const signed = await freighter.signTransaction(tx.toXDR(), {
      networkPassphrase: Networks.TESTNET,
      address,
    });
    if (signed.error) throw new Error(signed.error.message || String(signed.error));

    setStatus('Submitting payment...');
    return fetchJson(absoluteUrl(`payment/verify/stellar/${encodeURIComponent(itemId)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xdr: signed.signedTxXdr, destination, min_amount: amountUsd }),
    });
  }

  async function payOnEvm(network) {
    const destination = destinationFor(network);
    if (!window.ethereum) throw new Error('MetaMask is not available');
    setStatus('Connecting to MetaMask...');
    const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });

    setStatus('Switching network...');
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: network.chain_id_hex }],
      });
    } catch (switchError) {
      if (switchError && switchError.code === 4902) {
        throw new Error('Add ' + network.label + ' to MetaMask first, then try again.');
      }
      throw switchError;
    }

    // ERC-20 transfer(address,uint256), encoded by hand - one fixed call
    // shape doesn't need a whole ABI-encoding library.
    const selector = 'a9059cbb';
    const destinationWord = destination.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const amountUnits = BigInt(Math.round(amountUsd * 1000000)); // USDC: 6 decimals
    const amountWord = amountUnits.toString(16).padStart(64, '0');
    const data = '0x' + selector + destinationWord + amountWord;

    setStatus('Approve the payment in MetaMask...');
    const txHash = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: account, to: network.usdc_contract, data, value: '0x0' }],
    });

    setStatus('Waiting for the transaction to be mined - this can take a minute...');
    return fetchJson(absoluteUrl(`payment/verify/evm/${encodeURIComponent(itemId)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ network: network.key, tx_hash: txHash, destination, min_amount: amountUsd }),
    });
  }

  payButton.addEventListener('click', async () => {
    payButton.disabled = true;
    try {
      const network = currentNetwork();
      const receipt = network.chain === 'stellar' ? await payOnStellar(network) : await payOnEvm(network);
      setStatus('Payment confirmed.');
      onPaid(receipt);
    } catch (err) {
      setStatus('Payment failed: ' + (err && err.message ? err.message : String(err)));
      payButton.disabled = false;
    }
  });
}

// Injected once, scoped under .payment-widget-* so this drops into any
// page's own stylesheet without id collisions.
function injectStylesOnce() {
  if (document.getElementById('payment-widget-styles')) return;
  const style = document.createElement('style');
  style.id = 'payment-widget-styles';
  style.textContent = `
.payment-widget-description {
  color: #555;
  margin: 0 0 0.5rem;
  font-family: system-ui, sans-serif;
}
.payment-widget-label {
  display: block;
  margin: 0.75rem 0 0.25rem;
  font-weight: 600;
  font-size: 14px;
  font-family: system-ui, sans-serif;
}
.payment-widget-network,
.payment-widget-token {
  padding: 6px;
  font: inherit;
  font-family: system-ui, sans-serif;
}
.payment-widget-button {
  padding: 8px 16px;
  font-family: system-ui, sans-serif;
}
.payment-widget-status {
  color: #666;
  font-size: 14px;
  min-height: 1.2em;
  margin-top: 0.75rem;
  font-family: system-ui, sans-serif;
}
`;
  document.head.appendChild(style);
}
