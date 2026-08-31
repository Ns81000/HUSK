/**
 * Raw protocol driver for live testing against the deployed relay.
 * Node >= 24 (global fetch + WebSocket). Run from repo root: `node live-tests/<script>.mjs`
 */
export const BASE = "https://husk.ns8pc1.workers.dev";

export function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

export function assert(cond, label) {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  log("PASS:", label);
  return true;
}

export async function createRoom(pin) {
  const res = await fetchRetry(`${BASE}/room/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: pin }),
  });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

export async function joinRoom(pin) {
  const res = await fetchRetry(`${BASE}/room/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: pin }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

/** Fetch with connect-level retry: the audit network drops TLS connects. */
export async function fetchRetry(url, init, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastError;
}

/** Opens a socket with a join token; resolves after the welcome frame. */
export function connect(pin, joinToken, label = "") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${BASE.replace("https:", "wss:")}/room/${pin}/socket?jt=${joinToken}`,
    );
    const frames = [];
    const waiters = [];
    let open = true;
    ws.onmessage = (event) => {
      let parsed;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        parsed = { t: "RAW", data: String(event.data).slice(0, 120) };
      }
      frames.push(parsed);
      const idx = waiters.findIndex((w) => w.match(parsed));
      if (idx !== -1) {
        const [w] = waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(parsed);
      }
    };
    ws.onclose = (event) => {
      open = false;
      for (const w of waiters.splice(0)) {
        clearTimeout(w.timer);
        w.reject(new Error(`socket closed (${event.code}) while waiting`));
      }
    };
    ws.onerror = () => {};
    const waitFor = (match, timeoutMs = 10_000, lbl = "frame") => {
      if (typeof match === "string") {
        const tag = match;
        match = (m) => m.t === tag;
      }
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`waitFor timeout: ${lbl}`)), timeoutMs);
        waiters.push({ match, resolve: res, timer, label: lbl });
      });
    };
    ws.onopen = () => {
      waitFor("welcome", 10_000, "welcome")
        .then((welcome) =>
          resolve({
            ws,
            frames,
            isOpen: () => open,
            welcome,
            waitFor,
            label,
            close: () => ws.close(),
          }),
        )
        .catch(reject);
    };
    setTimeout(() => reject(new Error(`socket open timeout ${label}`)), 30_000);
  });
}

/** Seals a plaintext body the same way the browser does (AES-256-GCM). */
export function importRoomKeySync(fragment) {
  const raw = Uint8Array.from(atob(fragment), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function seal(key, body) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(body)),
    ),
  );
  return { iv: toBase64Url(iv), ct: toBase64Url(ct) };
}

export async function openSealed(key, envelope) {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(envelope.iv) },
    key,
    fromBase64Url(envelope.ct),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

export async function requestFileGrant(pin, member, size) {
  const res = await fetchRetry(`${BASE}/room/${pin}/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ size, member }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

export async function putChunk(chunkUrl, bytes) {
  const res = await fetchRetry(chunkUrl, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": "application/octet-stream" },
  });
  return { status: res.status, body: await res.text() };
}

export async function getFile(pin, fileId, exp, sig) {
  const res = await fetchRetry(
    `${BASE}/room/${pin}/file/${fileId}?exp=${exp}&sig=${encodeURIComponent(sig)}`,
  );
  return {
    status: res.status,
    bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : null,
    headers: res.headers,
  };
}

export function randomRoomId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let index = 0; index < 8; index += 1) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sendJson(ws, obj) {
  ws.send(JSON.stringify(obj));
}
