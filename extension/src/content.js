// Isolated-world relay between the page's connector object (inject.js) and
// the background. It keeps one Port per page open to the background, which
// learns the page's origin from Chrome, never from the page, and passes on
// the background's notice of a network change.
//
// Messages to the background are JSON and Chrome caps each one (64 MiB), so
// bytes travel as base64: small values inline ({ $bytes }), large ones (a
// prover key can pass 80 MB) as a blob uploaded in 8 MiB chunks first and
// named in the request ({ $blob }). Each chunk waits for the previous one's
// answer, so no more than one chunk is in flight. Bytes in answers come back
// as { $bytes } and reach the page as Uint8Array.
const PAGE = 'mdwa-page';
const CONTENT = 'mdwa-content';
const INLINE_MAX = 256 * 1024;
const CHUNK = 8 * 1024 * 1024;
// While a request waits (an approval window, a proof that takes minutes),
// a message every 20 seconds keeps the background's service worker from
// being stopped for inactivity, which would drop the request.
const KEEPALIVE_MS = 20000;

let port = null;
let next = 0;
const pending = new Map();
let keepalive = null;

function openPort() {
  port = chrome.runtime.connect({ name: 'mdwa-connector' });
  port.onMessage.addListener(message => {
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(message.error); else waiter.resolve(message.result);
    if (!pending.size) { clearInterval(keepalive); keepalive = null; }
  });
  port.onDisconnect.addListener(() => {
    port = null;
    clearInterval(keepalive);
    keepalive = null;
    for (const waiter of pending.values()) {
      waiter.reject({ type: 'DAppConnectorAPIError', code: 'Disconnected', reason: 'The connection to mdwa was lost: try again' });
    }
    pending.clear();
  });
}

function send(message) {
  if (!port) openPort();
  const id = ++next;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    keepalive ??= setInterval(() => { try { port?.postMessage({ op: 'ping' }); } catch { /* reconnects on the next request */ } }, KEEPALIVE_MS);
    port.postMessage({ ...message, id });
  });
}

function base64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

async function toWire(value) {
  if (value instanceof Uint8Array) {
    if (value.length <= INLINE_MAX) return { $bytes: base64(value) };
    const blobId = randomId();
    for (let offset = 0; offset < value.length; offset += CHUNK) {
      await send({ op: 'blob', blobId, offset, size: value.length, data: base64(value.subarray(offset, offset + CHUNK)) });
    }
    return { $blob: blobId };
  }
  if (Array.isArray(value)) return Promise.all(value.map(toWire));
  if (value && typeof value === 'object') {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, v]) => [k, await toWire(v)])));
  }
  return value;
}
function fromWire(value) {
  if (Array.isArray(value)) return value.map(fromWire);
  if (value && typeof value === 'object') {
    if (typeof value.$bytes === 'string' && Object.keys(value).length === 1) return fromBase64(value.$bytes);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromWire(v)]));
  }
  return value;
}

// The background's notice that mdwa's network changed, sent to this
// document alone and only while it holds a connection (see background.js):
// the page's object calls its onNetworkChange listeners.
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'networkChange') window.postMessage({ source: CONTENT, event: 'networkChange' }, window.location.origin);
});

window.addEventListener('message', event => {
  if (event.source !== window || event.data?.source !== PAGE) return;
  const { id, op, payload } = event.data;
  const answer = body => window.postMessage({ source: CONTENT, id, ...body }, window.location.origin);
  toWire(payload ?? {})
    .then(wire => send({ op, ...wire }))
    .then(result => answer({ result: fromWire(result) }), error => answer({
      error: error?.type === 'DAppConnectorAPIError' ? error
        : { type: 'DAppConnectorAPIError', code: 'InternalError', reason: String(error?.message ?? error) },
    }));
});
