# Husk

Ephemeral, end-to-end encrypted chat and file transfer. Two people, one 6-digit
PIN, one room key that never leaves the browser. Nothing is stored: when the
room closes, the conversation is gone.

## How it works

- A room is created client-side. The room key `K` (AES-256-GCM) is generated in
  the browser and lives only in the URL fragment (`/r/123456#<key>`), which
  browsers never send to a server.
- Every message and file chunk is encrypted before it leaves the tab. The relay
  sees ciphertext, an IV, and a room PIN — never plaintext, never the key.
- Relay state and encrypted file chunks live in SQLite-backed Cloudflare
  Durable Objects. There is no database and no bucket. An idle alarm closes the
  room server-side and purges every row, files included.
- File chunks move through short-lived HMAC-signed URLs. Upload URLs are
  single-use (each chunk row is write-once) and are only minted for
  participants with a live WebSocket in the room.

## Capacity limits (Workers Free plan)

- 25 MB per file, encrypted in 1 MiB chunks (one storage row each).
- 100 MB of live files per room; a transfer is refused beyond that.
- Account-wide SQLite storage is ~5 GB (roughly 200 concurrent max-size files
  across all rooms). Everything is purged when rooms close.

## Frontend

```sh
pnpm install
pnpm dev
```

Set the relay URL for the frontend (`.env` / Lovable environment variable):

```
VITE_WORKER_URL=https://husk.<your-subdomain>.workers.dev
```

## Cloudflare setup (manual, one time)

Lovable cannot provision Cloudflare resources for you. Run these yourself:

1. Install and authenticate Wrangler.

   ```sh
   pnpm add -g wrangler
   wrangler login
   ```

2. Set the ticket signing secret (any long random string).

   ```sh
   cd worker
   pnpm wrangler secret put HUSK_TICKET_SECRET
   ```

   No other resources are needed: both Durable Objects (rooms and the
   rate-limit gatekeeper) use the SQLite storage backend available on the
   Workers Free plan and are created by `wrangler deploy` itself.

3. Set `ALLOWED_ORIGINS` in `worker/wrangler.toml` to your frontend origins,
   comma separated, without trailing slashes.

4. Deploy the relay.

   ```sh
   cd worker
   pnpm deploy
   ```

5. Put the deployed Worker URL into `VITE_WORKER_URL` for the frontend and
   redeploy the site.

## Verification

```sh
pnpm test                                # unit tests (crypto, PIN, state machine, rate limiting)
cd worker && pnpm test                   # integration tests through the real routes in workerd
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec tsc --noEmit -p worker/tsconfig.json
pnpm lint
```

## Security notes

- The room key never appears in a request line, header, body, or log.
- The relay stores no message content, no history, and no user identity.
- File storage lives inside the room's own Durable Object and only a
  participant with a live WebSocket can reserve it; chunk uploads are
  write-once and ticket-scoped; downloads require a signed capability that is
  only ever relayed inside the encrypted message body.
- Join attempts (including WebSocket connects) are rate limited per IP and per
  PIN with exponential backoff.
