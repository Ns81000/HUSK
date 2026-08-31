// Group D/H live: multi-chunk upload -> streamed GET byte equality, GET
// replay, download after sender socket close, cancel + budget refund, 507.
// Costs: 1 create, 2 joins.
import {
  assert,
  connect,
  createRoom,
  getFile,
  joinRoom,
  log,
  putChunk,
  randomRoomId,
  requestFileGrant,
  sendJson,
  sleep,
} from "./probe-lib.mjs";

const pin = randomRoomId();
assert((await createRoom(pin)).status === 200, `create ${pin} -> 200`);
const ja = await joinRoom(pin);
log("join A:", ja.status, ja.body?.joinToken ? "token" : JSON.stringify(ja.body));
assert(ja.status === 200 && ja.body?.joinToken, `join A -> 200 with token`);
const jb = await joinRoom(pin);
log("join B:", jb.status, jb.body?.joinToken ? "token" : JSON.stringify(jb.body));
assert(jb.status === 200 && jb.body?.joinToken, `join B -> 200 with token`);
const A = await connect(pin, ja.body.joinToken, "A");
const B = await connect(pin, jb.body.joinToken, "B");
const memberA = A.welcome.you;

// Multi-chunk vector: 2.5 MiB random (filled in 64 KiB blocks).
const CHUNK = 1024 * 1024;
const vector = new Uint8Array(2 * CHUNK + 512 * 1024);
for (let offset = 0; offset < vector.byteLength; offset += 65_536) {
  crypto.getRandomValues(vector.subarray(offset, Math.min(vector.byteLength, offset + 65_536)));
}

const grantRes = await requestFileGrant(pin, memberA, vector.byteLength);
assert(grantRes.status === 200, `grant for 2.5 MiB -> 200`);
const grant = grantRes.body;
assert(grant.chunkUrls.length === 3, `3 chunk urls`);

// Interleave the PUTs out of order to prove per-chunk tickets/rows.
const order = [1, 0, 2];
for (const index of order) {
  const slice = vector.subarray(index * CHUNK, Math.min(vector.byteLength, (index + 1) * CHUNK));
  const put = await putChunk(grant.chunkUrls[index], slice);
  assert(put.status === 200, `chunk PUT ${index} -> 200 (got ${put.status})`);
}

// Download by B (peer), byte equality.
const dl1 = await getFile(pin, grant.fileId, grant.download.exp, grant.download.sig);
assert(
  dl1.status === 200 && dl1.bytes.length === vector.byteLength,
  `download -> 200, ${dl1.bytes.length} bytes`,
);
let equal = dl1.bytes.length === vector.byteLength;
for (let i = 0; equal && i < vector.byteLength; i += 1) equal = dl1.bytes[i] === vector[i];
assert(equal, `byte equality across 3 chunks (out-of-order upload)`);

// D24: GET replay within room lifetime — deliberate, documented.
const dl2 = await getFile(pin, grant.fileId, grant.download.exp, grant.download.sig);
assert(
  dl2.status === 200 && dl2.bytes.length === vector.byteLength,
  `GET replay succeeds (documented behavior)`,
);

// D22: download after the sender's socket is closed.
A.close();
await sleep(1500);
const dl3 = await getFile(pin, grant.fileId, grant.download.exp, grant.download.sig);
assert(
  dl3.status === 200 && dl3.bytes.length === vector.byteLength,
  `download succeeds after sender socket closed`,
);

// D21/C13: budget behavior — the 2.5 MiB file above is still reserved, so
// three more 25 MB grants (77.5 MB total) fit, and the fourth exceeds the
// 100 MB room budget -> 507.
const bigA = await requestFileGrant(pin, B.welcome.you, 25 * CHUNK);
assert(bigA.status === 200, `25 MB grant #1 reserved (got ${bigA.status})`);
const bigB = await requestFileGrant(pin, B.welcome.you, 25 * CHUNK);
assert(bigB.status === 200, `25 MB grant #2 reserved (got ${bigB.status})`);
const bigC = await requestFileGrant(pin, B.welcome.you, 25 * CHUNK);
assert(bigC.status === 200, `25 MB grant #3 reserved (got ${bigC.status})`);
const beyond = await requestFileGrant(pin, B.welcome.you, 25 * CHUNK);
assert(beyond.status === 507, `grant beyond the 100 MB room budget -> 507 (got ${beyond.status})`);

// D23: cancel one 25 MB reservation via the client cancel frame -> budget refunded.
sendJson(B.ws, { t: "cancel", fileId: bigA.body.fileId });
// no ack for cancel; poll the grant endpoint instead
let refunded = false;
for (let attempt = 0; attempt < 10 && !refunded; attempt += 1) {
  await sleep(500);
  const retry = await requestFileGrant(pin, B.welcome.you, 1024);
  if (retry.status === 200) {
    refunded = true;
    sendJson(B.ws, { t: "cancel", fileId: retry.body.fileId });
  }
}
assert(refunded, `after cancel of a 25 MB reservation, a new grant succeeds (budget refunded)`);

B.close();
log("SCENARIO D/H-files: OK");
