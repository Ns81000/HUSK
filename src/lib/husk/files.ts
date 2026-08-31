/**
 * File encryption and transfer.
 *
 * Files are encrypted in the browser before they touch the network. Each
 * 1 MiB chunk is sealed and uploaded as its own signed request, and downloads
 * are decrypted incrementally from the response stream, so the full ciphertext
 * is never materialised on either end. The relay only ever stores ciphertext,
 * inside the room's Durable Object, and only until the room closes.
 */

import { FILE_CHUNK_BYTES, MAX_FILE_BYTES, WORKER_URL } from "./config";
import { openBytes, sealBytes, toBase64Url, fromBase64Url } from "./crypto";

export type FileGrant = {
  readonly fileId: string;
  readonly chunkUrls: readonly string[];
  readonly download: { readonly exp: number; readonly sig: string };
};

/** The fields a peer needs to fetch and decrypt one stored file. */
export type FileReference = {
  readonly fileId: string;
  readonly chunks: number;
  readonly ivs: readonly string[];
  readonly lengths: readonly number[];
  readonly exp: number;
  readonly sig: string;
};

export class FileTooLargeError extends Error {
  constructor() {
    super("File exceeds the maximum allowed size");
    this.name = "FileTooLargeError";
  }
}

export class EmptyFileError extends Error {
  constructor() {
    super("Empty files cannot be sent");
    this.name = "EmptyFileError";
  }
}

/** Carries the fileId so a failed upload can cancel its reserved storage. */
export class UploadFailedError extends Error {
  constructor(readonly fileId: string | null) {
    super("Upload failed");
    this.name = "UploadFailedError";
  }
}

/**
 * Client-side size guards. These must run BEFORE the storage-grant request:
 * the relay rejects a 0-byte or over-cap grant with 400, so asking first
 * would send a request that can never succeed. `encryptAndUpload` re-checks
 * so the guard also holds for direct callers.
 */
export function assertFileSendable(size: number): void {
  if (size === 0) {
    throw new EmptyFileError();
  }
  if (size > MAX_FILE_BYTES) {
    throw new FileTooLargeError();
  }
}

/**
 * Asks the room for file storage. `member` is this tab's live participant id:
 * the Durable Object rejects the request unless that participant currently
 * holds a WebSocket in the room.
 */
export async function requestFileUpload(
  roomId: string,
  member: string,
  size: number,
): Promise<FileGrant> {
  const response = await fetch(`${WORKER_URL}/room/${roomId}/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ size, member }),
  });
  if (!response.ok) {
    throw new UploadFailedError(null);
  }
  // SAFETY: the grant endpoint is our own Worker and returns this exact shape;
  // the fields are validated below before use.
  const grant = (await response.json()) as Partial<FileGrant>;
  if (
    grant.fileId === undefined ||
    grant.download === undefined ||
    !Array.isArray(grant.chunkUrls) ||
    grant.chunkUrls.length === 0
  ) {
    throw new UploadFailedError(null);
  }
  return grant as FileGrant;
}

/**
 * Encrypts a file chunk-by-chunk, uploading each chunk the moment it is
 * sealed. Nothing accumulates: at most one plaintext chunk and one ciphertext
 * chunk are in memory at a time.
 */
export async function encryptAndUpload(
  key: CryptoKey,
  file: File,
  grant: FileGrant,
  onProgress: (fraction: number) => void,
): Promise<FileReference> {
  assertFileSendable(file.size);

  const total = Math.max(1, Math.ceil(file.size / FILE_CHUNK_BYTES));
  if (grant.chunkUrls.length < total) {
    throw new UploadFailedError(grant.fileId);
  }
  const ivs: string[] = [];
  const lengths: number[] = [];

  for (let index = 0; index < total; index += 1) {
    const slice = file.slice(index * FILE_CHUNK_BYTES, (index + 1) * FILE_CHUNK_BYTES);
    const plaintext = new Uint8Array(await slice.arrayBuffer());
    const { iv, ciphertext } = await sealBytes(key, plaintext);
    ivs.push(toBase64Url(iv));
    lengths.push(ciphertext.byteLength);

    const chunkUrl = grant.chunkUrls[index];
    if (chunkUrl === undefined) {
      throw new UploadFailedError(grant.fileId);
    }
    const response = await fetch(chunkUrl, {
      method: "PUT",
      body: ciphertext,
      headers: { "content-type": "application/octet-stream" },
    });
    // 409 means this chunk row already holds our bytes (a retried request);
    // any other failure aborts the upload.
    if (!response.ok && response.status !== 409) {
      throw new UploadFailedError(grant.fileId);
    }
    onProgress((index + 1) / total);
  }

  return {
    fileId: grant.fileId,
    chunks: total,
    ivs,
    lengths,
    exp: grant.download.exp,
    sig: grant.download.sig,
  };
}

/**
 * Reassembles fixed-length byte spans from arbitrarily-framed network chunks.
 * Holds only the bytes of the span currently being completed.
 */
class ByteQueue {
  private readonly parts: Uint8Array[] = [];
  private length = 0;

  push(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.length += bytes.byteLength;
  }

  take(count: number): Uint8Array | null {
    if (this.length < count) {
      return null;
    }
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const head = this.parts[0];
      if (head === undefined) {
        break;
      }
      const need = count - filled;
      if (head.byteLength <= need) {
        out.set(head, filled);
        filled += head.byteLength;
        this.length -= head.byteLength;
        this.parts.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.parts[0] = head.subarray(need);
        this.length -= need;
        filled = count;
      }
    }
    return out;
  }
}

/**
 * Downloads the stored ciphertext as a stream and decrypts it chunk-by-chunk
 * as bytes arrive, never buffering more than the chunk being completed.
 */
export async function downloadAndDecrypt(
  key: CryptoKey,
  roomId: string,
  file: FileReference,
  mime: string,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const response = await fetch(
    `${WORKER_URL}/room/${roomId}/file/${file.fileId}?exp=${file.exp}&sig=${encodeURIComponent(file.sig)}`,
  );
  if (!response.ok || response.body === null) {
    throw new Error("Download failed");
  }

  const totalCiphertext = file.lengths.reduce((sum, length) => sum + length, 0);
  const reader = response.body.getReader();
  const queue = new ByteQueue();
  const plaintexts: BlobPart[] = [];
  let received = 0;
  let index = 0;

  while (index < file.lengths.length) {
    const { done, value } = await reader.read();
    if (done || value === undefined) {
      throw new Error("Download ended early");
    }
    queue.push(value);
    received += value.byteLength;
    onProgress(Math.min(0.9, (received / Math.max(1, totalCiphertext)) * 0.9));

    while (index < file.lengths.length) {
      const length = file.lengths[index];
      const iv = file.ivs[index];
      if (length === undefined || iv === undefined) {
        throw new Error("Missing chunk metadata");
      }
      const ciphertext = queue.take(length);
      if (ciphertext === null) {
        break;
      }
      plaintexts.push(await openBytes(key, fromBase64Url(iv), ciphertext));
      index += 1;
    }
  }
  onProgress(1);

  return new Blob(plaintexts, { type: mime });
}
