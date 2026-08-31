// Group E (security) + D (file ticket edges) against the live relay.
// Costs: 1 create, 1 join.
import {
  assert,
  connect,
  createRoom,
  joinRoom,
  log,
  putChunk,
  randomRoomId,
  requestFileGrant,
} from "./probe-lib.mjs";

const FRONTEND = "https://ns81000-husk.ns8pc1.workers.dev";
const pin = randomRoomId();
assert((await createRoom(pin)).status === 200, `create ${pin} -> 200`);
const jb = await joinRoom(pin);
assert(jb.status === 200, `join -> 200`);
const S = await connect(pin, jb.body.joinToken, "S");
const member = S.welcome.you;

// --- E27/E28: token replay, forged, tokenless — upgrade must fail (generic 404) ---
// Node fetch cannot send a WS upgrade, so failure is observed on the WebSocket:
// a rejected handshake never opens. (Byte-identical 404 equality is pinned by
// the workerd suite; CDP status capture in live-drive confirms the 404 live.)
function upgradeFails(pinValue, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `wss://husk.ns8pc1.workers.dev/room/${pinValue}/socket?jt=${encodeURIComponent(token)}`,
    );
    const result = { opened: false, closed: false };
    const done = () => {
      ws.onopen = ws.onerror = ws.onclose = null;
      resolve(result);
    };
    ws.onopen = () => {
      result.opened = true;
      ws.close();
      done();
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      result.closed = true;
      done();
    };
    setTimeout(done, 8000);
  });
}
const replayResult = await upgradeFails(pin, jb.body.joinToken);
assert(!replayResult.opened, `replayed token never opens a socket`);
const forgedResult = await upgradeFails(pin, "9999999999.AAAA.BBBB");
assert(!forgedResult.opened, `forged token never opens a socket`);
const tokenlessResult = await upgradeFails(pin, "");
assert(!tokenlessResult.opened, `tokenless socket never opens`);

// --- file grant + ticket edges ---
const grantRes = await requestFileGrant(pin, member, 4096);
assert(grantRes.status === 200, `file grant -> 200 (got ${grantRes.status})`);
const grant = grantRes.body;
const chunkUrl = new URL(grant.chunkUrls[0]);
const bytes = new Uint8Array(4096).fill(7);

// expired exp -> 403
const expiredRes = await fetch(
  `https://husk.ns8pc1.workers.dev${chunkUrl.pathname}?exp=1000000000&sig=${chunkUrl.searchParams.get("sig")}`,
  { method: "PUT", body: bytes },
);
assert(expiredRes.status === 403, `chunk PUT expired exp -> 403 (got ${expiredRes.status})`);

// D25/E29: file GET edges
const unsignedGet = await fetch(`https://husk.ns8pc1.workers.dev/room/${pin}/file/${grant.fileId}`);
assert(unsignedGet.status === 403, `unsigned file GET -> 403 (got ${unsignedGet.status})`);
const forgedGet = await fetch(
  `https://husk.ns8pc1.workers.dev/room/${pin}/file/${grant.fileId}?exp=${grant.download.exp}&sig=${"A".repeat(43)}`,
);
assert(forgedGet.status === 403, `forged sig file GET -> 403 (got ${forgedGet.status})`);
const expiredGet = await fetch(
  `https://husk.ns8pc1.workers.dev/room/${pin}/file/${grant.fileId}?exp=1000000000&sig=${grant.download.sig}`,
);
assert(expiredGet.status === 403, `expired exp file GET -> 403 (got ${expiredGet.status})`);
const otherPin = randomRoomId();
await createRoom(otherPin);
const wrongPinGet = await fetch(
  `https://husk.ns8pc1.workers.dev/room/${otherPin}/file/${grant.fileId}?exp=${grant.download.exp}&sig=${grant.download.sig}`,
);
assert(
  wrongPinGet.status === 403 || wrongPinGet.status === 404,
  `wrong-pin file GET -> 403/404 (got ${wrongPinGet.status})`,
);

// D19/D20 grant shapes
const zeroGrant = await requestFileGrant(pin, member, 0);
assert(zeroGrant.status === 400, `0-byte grant -> 400 (got ${zeroGrant.status})`);
const tooBigGrant = await requestFileGrant(pin, member, 25 * 1024 * 1024 + 1);
assert(tooBigGrant.status === 400, `>25MB grant -> 400 (got ${tooBigGrant.status})`);
const notMemberGrant = await requestFileGrant(pin, "00000000-0000-4000-8000-000000000000", 1024);
assert(notMemberGrant.status === 403, `non-member grant -> 403 (got ${notMemberGrant.status})`);
const maxGrant = await requestFileGrant(pin, member, 25 * 1024 * 1024);
assert(
  maxGrant.status === 200 && maxGrant.body.chunkUrls.length === 25,
  `exactly-25MB grant -> 200 with 25 chunk urls (got ${maxGrant.status}, ${maxGrant.body?.chunkUrls?.length})`,
);

// E30: CORS matrix
async function corsProbe(path, init, origin) {
  const headers = { ...(init?.headers ?? {}) };
  if (origin !== null) headers["Origin"] = origin;
  const res = await fetch(`https://husk.ns8pc1.workers.dev${path}`, { ...init, headers });
  return { acao: res.headers.get("access-control-allow-origin"), status: res.status };
}
const allowedPost = await corsProbe(
  "/room/create",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: randomRoomId() }),
  },
  FRONTEND,
);
assert(allowedPost.acao === FRONTEND, `allowed origin gets ACAO (got ${allowedPost.acao})`);
const disallowedPost = await corsProbe(
  "/room/create",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: randomRoomId() }),
  },
  "https://evil.example",
);
assert(disallowedPost.acao === null, `disallowed origin gets NO ACAO (got ${disallowedPost.acao})`);
const noOriginPost = await corsProbe(
  "/room/create",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roomId: randomRoomId() }),
  },
  null,
);
assert(
  noOriginPost.acao === null && noOriginPost.status === 200,
  `no-origin request served 200 without ACAO (status ${noOriginPost.status}, ACAO ${noOriginPost.acao})`,
);
const preflight = await corsProbe(
  `/room/${pin}/file/${grant.fileId}`,
  { method: "OPTIONS" },
  FRONTEND,
);
assert(
  preflight.status === 204 && preflight.acao === FRONTEND,
  `OPTIONS preflight -> 204 + ACAO (got ${preflight.status}, ${preflight.acao})`,
);
const putCors = await fetch(
  `https://husk.ns8pc1.workers.dev${chunkUrl.pathname}?exp=${chunkUrl.searchParams.get("exp")}&sig=${chunkUrl.searchParams.get("sig")}`,
  {
    method: "PUT",
    body: bytes,
    headers: { Origin: FRONTEND },
  },
);
assert(
  putCors.headers.get("access-control-allow-origin") === FRONTEND,
  `chunk PUT for allowed origin carries ACAO`,
);

S.close();
log("SCENARIO E+D-edges: OK");
