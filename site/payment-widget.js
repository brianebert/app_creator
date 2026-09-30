// Ready-made "pay with crypto" widget - the same real, independently
// verified USDC-on-testnet payment flow shipped on the platform's own
// /create-app page, generalized so any generated site can charge its own
// price to its own wallet. Chassis still submits (Stellar) or polls
// (EVM) the transaction and independently checks the real on-chain effect
// before telling this widget the payment is good - it never trusts the
// wallet's or this page's own claim.
//
// Usage - add one container element and one script tag to index.html:
//
//   <div id="pay"></div>
//   <script src="payment-widget.js"></script>
//   <script>
//     mountPaymentWidget(document.getElementById('pay'), {
//       amountUsd: 5,
//       description: 'One month of premium',
//       destination: {
//         stellar: 'G...',      // your own Stellar testnet address
//         evm: '0x...',         // your own EVM address (works on every
//                                // supported EVM network - Sepolia, Amoy)
//       },
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
// Only the chains you pass a `destination` for are offered - pass just
// `stellar`, just `evm`, or both. Every network this sidecar knows about
// is fetched live from `GET /payment/networks` (the same data-driven
// pattern /create-app's own page uses), so a new network or token shows up
// automatically without any change here.
//
// Testnet only, same as /create-app - real receiving addresses, fake
// money. Users pay their own network fee; there is no fee sponsorship yet.
function mountPaymentWidget(container, options) {
  options = options || {};
  const amountUsd = options.amountUsd;
  const destinations = options.destination || {};
  const description = options.description || '';
  const onPaid = typeof options.onPaid === 'function' ? options.onPaid : () => {};
  if (!amountUsd || amountUsd <= 0) {
    throw new Error('mountPaymentWidget requires a positive options.amountUsd');
  }
  if (!destinations.stellar && !destinations.evm) {
    throw new Error('mountPaymentWidget requires options.destination.stellar and/or .evm');
  }

  injectStylesOnce();

  // Same position-based prefix as chat-widget.js - correct here for the
  // same reason: every harness-built site is single-page, so the page's
  // own mount root is always exactly one segment short of its own URL. Do
  // not copy this into a multi-page app (see chat-widget.js's own note).
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
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  container.innerHTML =
    (description ? `<p class="payment-widget-description"></p>` : '') +
    '<label class="payment-widget-label">Pay with</label>' +
    '<select class="payment-widget-network"></select>' +
    '<select class="payment-widget-token"></select>' +
    '<p><button type="button" class="payment-widget-button" disabled>Loading payment options...</button></p>' +
    '<p class="payment-widget-status"></p>';
  if (description) {
    container.querySelector('.payment-widget-description').textContent = description;
  }
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
      const all = await fetchJson(absoluteUrl('payment/networks'));
      networks = all.networks.filter((n) => Boolean(destinationFor(n)));
      if (networks.length === 0) {
        throw new Error('no supported chain matches the destination(s) given to mountPaymentWidget');
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
    return fetchJson(absoluteUrl('payment/verify/stellar'), {
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
    return fetchJson(absoluteUrl('payment/verify/evm'), {
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
