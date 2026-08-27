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
- Relay state lives in memory inside a Cloudflare Durable Object. There is no
  database. An idle alarm closes the room server-side and drops all state.
- File chunks go to R2 through short-lived, single-use, HMAC-signed tickets and
  are deleted by an R2 lifecycle rule.

## Frontend

```sh
npm i
npm run dev
```

Set the relay URL for the frontend (`.env` / Lovable environment variable):

```
VITE_WORKER_URL=https://husk.<your-subdomain>.workers.dev
```

## Cloudflare setup (manual, one time)

Lovable cannot provision Cloudflare resources for you. Run these yourself:

1. Install and authenticate Wrangler.

   ```sh
   npm install -g wrangler
   wrangler login
   ```

2. Create the R2 bucket for encrypted file chunks.

   ```sh
   wrangler r2 bucket create husk-files
   ```

3. Apply the lifecycle rule so uploads expire automatically.

   ```sh
   wrangler r2 bucket lifecycle add husk-files --file worker/r2-lifecycle.json
   ```

4. Create the KV namespace used for PIN/IP rate limiting and copy the returned
   `id` into `worker/wrangler.toml` (`HUSK_RATE_LIMIT`).

   ```sh
   wrangler kv namespace create HUSK_RATE_LIMIT
   ```

5. Set the ticket signing secret (any long random string).

   ```sh
   cd worker
   wrangler secret put HUSK_TICKET_SECRET
   ```

6. Set `ALLOWED_ORIGINS` in `worker/wrangler.toml` to your frontend origins,
   comma separated, without trailing slashes.

7. Deploy the relay.

   ```sh
   cd worker
   wrangler deploy
   ```

8. Put the deployed Worker URL into `VITE_WORKER_URL` for the frontend and
   redeploy the site.

## Verification

```sh
npm run test        # crypto, room state machine, rate limiting, protocol
npx tsgo -p tsconfig.json
npx tsgo -p worker/tsconfig.json
npx oxlint
```

## Security notes

- The room key never appears in a request line, header, body, or log.
- The relay stores no message content, no history, and no user identity.
- Upload and download tickets are single-use, scoped to one object key, and
  expire in minutes.
- Join attempts are rate limited per IP and per PIN with exponential backoff.
