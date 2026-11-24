// The DApp Connector API 4.1.0 in the page's MAIN world: one frozen InitialAPI
// installed under window.midnight[<fresh UUIDv4>]. Every call is relayed
// through the extension's isolated content script to the background, which
// decides using the page origin Chrome reports (not anything this page says).
//
// The wire carries JSON-safe values: amounts (bigint here) cross as decimal
// strings and are rebuilt as bigint; bytes cross as Uint8Array to the content
// script, which takes care of encoding them. Errors arrive as plain
// { type, code, reason } and are rebuilt as Errors with those properties, as
// the specification describes APIError.
//
// getProvingProvider keeps the dApp's KeyMaterialProvider in the page: for a
// circuit the wallet does not hold yet, the page reads the ZKIR and both
// keys, and sends them once with a digest the wallet caches them under; each
// check or prove then sends only the preimage and the key location.
(() => {
  const PAGE = 'mdwa-page';
  const CONTENT = 'mdwa-content';
  const API_VERSION = '4.1.0';
  // The brand mark: the bold moon glyph on brand blue, as in the popup.
  const ICON = `data:image/svg+xml;base64,${btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" rx="8" fill="#056dff"/>'
    + '<svg x="5.6" y="5.6" width="16.8" height="16.8" viewBox="0 0 256 256"><path fill="#fff" d="M236.37,139.4a12,12,0,0,0-12-3A84.07,84.07,0,0,1,119.6,31.59a12,12,0,0,0-15-15A108.86,108.86,0,0,0,49.69,55.07,108,108,0,0,0,136,228a107.09,107.09,0,0,0,64.93-21.69,108.86,108.86,0,0,0,38.44-54.94A12,12,0,0,0,236.37,139.4Zm-49.88,47.74A84,84,0,0,1,68.86,69.51,84.93,84.93,0,0,1,92.27,48.29Q92,52.13,92,56A108.12,108.12,0,0,0,200,164q3.87,0,7.71-.27A84.79,84.79,0,0,1,186.49,187.14Z"/></svg></svg>',
  )}`;

  let next = 0;
  const pending = new Map();
  const networkListeners = new Set();
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== CONTENT) return;
    if (event.data.event === 'networkChange') {
      for (const notify of [...networkListeners]) {
        try { notify(); } catch (error) { reportError(error); }
      }
      return;
    }
    const waiter = pending.get(event.data.id);
    if (!waiter) return;
    pending.delete(event.data.id);
    if (event.data.error) waiter.reject(apiError(event.data.error)); else waiter.resolve(event.data.result);
  });
  function apiError({ code = 'InternalError', reason = 'Unknown error' } = {}) {
    const error = new Error(reason);
    error.name = 'DAppConnectorAPIError';
    error.type = 'DAppConnectorAPIError';
    error.code = code;
    error.reason = reason;
    return error;
  }
  const request = (op, payload) => new Promise((resolve, reject) => {
    const id = `${Date.now()}-${++next}`;
    pending.set(id, { resolve, reject });
    window.postMessage({ source: PAGE, id, op, payload }, window.location.origin);
  });

  // ------------------------------------------------------------ encoding ---
  const amount = (value, name) => {
    if (typeof value === 'bigint' && value >= 0n) return value.toString();
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    throw apiError({ code: 'InvalidRequest', reason: `${name} must be a non-negative bigint` });
  };
  const list = (value, name) => {
    if (!Array.isArray(value)) throw apiError({ code: 'InvalidRequest', reason: `${name} must be an array` });
    return value;
  };
  const outputs = value => list(value, 'desiredOutputs').map(o => ({ kind: o?.kind, type: o?.type, value: amount(o?.value, 'value'), recipient: o?.recipient }));
  const inputs = value => list(value, 'desiredInputs').map(i => ({ kind: i?.kind, type: i?.type, value: amount(i?.value, 'value') }));
  const bigints = record => Object.fromEntries(Object.entries(record ?? {}).map(([k, v]) => [k, BigInt(v)]));

  // ---------------------------------------------------------- proving ---
  async function sha256(bytes) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  }
  // The digest the wallet caches key material under (see connector.js):
  // SHA-256 over the SHA-256 of the ZKIR, prover key and verifier key.
  // Without Web Crypto (a page not served securely) there is no digest and
  // the material is sent every time.
  async function keyDigest(ir, proverKey, verifierKey) {
    if (!crypto.subtle) return null;
    const parts = await Promise.all([ir, proverKey, verifierKey].map(sha256));
    const joined = new Uint8Array(96);
    parts.forEach((p, i) => joined.set(p, i * 32));
    return Array.from(await sha256(joined), b => b.toString(16).padStart(2, '0')).join('');
  }
  const asBytes = (value, what) => {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw apiError({ code: 'InvalidRequest', reason: `The key material provider returned ${what} that is not a Uint8Array` });
  };

  function provingProvider(connectionId, keyMaterialProvider) {
    const call = (method, params) => request('call', { connectionId, method, args: [params] });
    // One upload per key location for this provider; a failed one is tried
    // again on the next proof.
    const ready = new Map();
    function ensureKey(keyLocation) {
      if (keyLocation.startsWith('midnight/')) return Promise.resolve(null);
      if (!ready.has(keyLocation)) {
        const upload = (async () => {
          const [ir, proverKey, verifierKey] = await Promise.all([
            keyMaterialProvider.getZKIR(keyLocation), keyMaterialProvider.getProverKey(keyLocation), keyMaterialProvider.getVerifierKey(keyLocation),
          ]).then(([a, b, c]) => [asBytes(a, 'a ZKIR'), asBytes(b, 'a prover key'), asBytes(c, 'a verifier key')]);
          const digest = await keyDigest(ir, proverKey, verifierKey);
          if (digest && (await call('_proverHasKey', { keyLocation, digest })).cached) return digest;
          return (await call('_proverPutKey', { keyLocation, digest, ir, proverKey, verifierKey })).digest;
        })();
        ready.set(keyLocation, upload);
        upload.catch(() => ready.delete(keyLocation));
      }
      return ready.get(keyLocation);
    }
    const location = keyLocation => {
      if (typeof keyLocation !== 'string' || !keyLocation) throw apiError({ code: 'InvalidRequest', reason: 'keyLocation must be a string' });
      return keyLocation;
    };
    return Object.freeze({
      check: async (serializedPreimage, keyLocation) => {
        const digest = await ensureKey(location(keyLocation));
        const result = await call('_proverCheck', { keyLocation, digest, preimage: asBytes(serializedPreimage, 'a preimage') });
        return result.map(v => (v === null ? undefined : BigInt(v)));
      },
      prove: async (serializedPreimage, keyLocation, overwriteBindingInput) => {
        const digest = await ensureKey(location(keyLocation));
        return call('_proverProve', {
          keyLocation, digest, preimage: asBytes(serializedPreimage, 'a preimage'),
          binding: overwriteBindingInput === undefined ? null : amount(overwriteBindingInput, 'overwriteBindingInput'),
        });
      },
    });
  }

  // --------------------------------------------------------- connected ---
  function connectedApi(connectionId) {
    const call = (method, ...args) => request('call', { connectionId, method, args });
    return Object.freeze({
      getShieldedBalances: async () => bigints(await call('getShieldedBalances')),
      getUnshieldedBalances: async () => bigints(await call('getUnshieldedBalances')),
      getDustBalance: async () => {
        const { cap, balance } = await call('getDustBalance');
        return { cap: BigInt(cap), balance: BigInt(balance) };
      },
      getShieldedAddresses: () => call('getShieldedAddresses'),
      getUnshieldedAddress: () => call('getUnshieldedAddress'),
      getDustAddress: () => call('getDustAddress'),
      getTxHistory: (pageNumber, pageSize) => call('getTxHistory', pageNumber, pageSize),
      balanceUnsealedTransaction: (tx, options) => call('balanceUnsealedTransaction', tx, options),
      balanceSealedTransaction: (tx, options) => call('balanceSealedTransaction', tx, options),
      makeTransfer: async (desiredOutputs, options) => call('makeTransfer', outputs(desiredOutputs), options),
      makeIntent: async (desiredInputs, desiredOutputs, options) => call('makeIntent', inputs(desiredInputs), outputs(desiredOutputs), options),
      signData: (data, options) => call('signData', data, options),
      submitTransaction: async tx => { await call('submitTransaction', tx); },
      getProvingProvider: async keyMaterialProvider => {
        for (const name of ['getZKIR', 'getProverKey', 'getVerifierKey']) {
          if (typeof keyMaterialProvider?.[name] !== 'function') throw apiError({ code: 'InvalidRequest', reason: `The key material provider has no ${name}` });
        }
        await call('getProvingProvider');
        return provingProvider(connectionId, keyMaterialProvider);
      },
      getConfiguration: () => call('getConfiguration'),
      getConnectionStatus: () => call('getConnectionStatus'),
      hintUsage: async methodNames => { await call('hintUsage', methodNames); },
      // Beyond the API: a label for a token, which the user approves.
      watchToken: request => call('watchToken', request),
    });
  }

  // Beyond the API: connect's optional `{ endpoint }`, connect without a
  // network id (the selected network, never switching), addNetwork and
  // onNetworkChange (see docs/dapp-connector.md, "Beyond the standard API").
  // A listener is called with no arguments when mdwa's network changes, only
  // while this page holds a connection; it returns a function that removes it.
  const initialApi = Object.freeze({
    rdns: 'wallet.mdwa',
    name: 'mdwa',
    icon: ICON,
    apiVersion: API_VERSION,
    connect: async (networkId, options) => {
      const { connectionId } = await request('connect', { networkId, options });
      return connectedApi(connectionId);
    },
    addNetwork: definition => request('addNetwork', { definition }),
    onNetworkChange: listener => {
      if (typeof listener !== 'function') throw apiError({ code: 'InvalidRequest', reason: 'onNetworkChange takes a function' });
      const notify = () => { listener(); };
      networkListeners.add(notify);
      return () => { networkListeners.delete(notify); };
    },
  });

  // ------------------------------------------------------------ install ---
  // The first wallet creates window.midnight so nobody can replace it; a
  // wallet that came first keeps its object and its entries. Ours goes under
  // a fresh UUIDv4, as a property nobody can overwrite.
  function uuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  try {
    if (!Object.getOwnPropertyDescriptor(window, 'midnight')) {
      Object.defineProperty(window, 'midnight', { value: Object.create(null), writable: false, configurable: false, enumerable: true });
    }
    const root = window.midnight;
    if (root && typeof root === 'object') {
      Object.defineProperty(root, uuid(), { value: initialApi, writable: false, configurable: false, enumerable: true });
    }
  } catch { /* window.midnight is sealed by someone else: there is nowhere to install */ }
})();
