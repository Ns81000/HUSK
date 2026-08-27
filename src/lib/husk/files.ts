/**
 * File encryption and transfer.
 *
 * Files are encrypted in the browser before they touch the network. Large
 * files are chunked so the whole plaintext is never buffered in memory. The
 * Worker only ever issues short-lived signed URLs; R2 only ever stores
 * ciphertext.
 */

import {
  FILE_CHUNK_BYTES,
  FILE_CHUNK_THRESHOLD_BYTES,
  MAX_FILE_BYTES,
  WORKER_URL,
} from "./config";
import { openBytes, sealBytes, toBase64Url, fromBase64Url } from "./crypto";

export type UploadTicket = {
  readonly objectKey: string;
  readonly uploadUrl: string;
  readonly downloadUrl: string;
};

export type EncryptedUpload = {
  readonly objectKey: string;
  readonly chunks: number;
  readonly ivs: readonly string[];
  readonly lengths: readonly number[];
};

export class FileTooLargeError extends Error {
  constructor() {
    super("File exceeds the maximum allowed size");
    this.name = "FileTooLargeError";
  }
}

function chunkSizeFor(size: number): number {
  return size > FILE_CHUNK_THRESHOLD_BYTES ? FILE_CHUNK_BYTES : size;
}

export async function requestUploadTicket(
  pin: string,
  size: number,
): Promise<UploadTicket> {
  const response = await fetch(`${WORKER_URL}/room/${pin}/upload-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ size }),
  });
  if (!response.ok) {
    throw new Error("Could not get an upload ticket");
  }
  // SAFETY: the ticket endpoint is our own Worker and returns this exact shape;
  // the fields are validated below before use.
  const ticket = (await response.json()) as UploadTicket;
  if (
    ticket.objectKey === undefined ||
    ticket.uploadUrl === undefined ||
    ticket.downloadUrl === undefined
  ) {
    throw new Error("Malformed upload ticket");
  }
  return ticket;
}

/**
 * Encrypts a file chunk-by-chunk and uploads the ciphertext to the signed URL.
 * Returns the metadata the peer needs to fetch and decrypt it.
 */
export async function encryptAndUpload(
  key: CryptoKey,
  file: File,
  ticket: UploadTicket,
  onProgress: (fraction: number) => void,
): Promise<EncryptedUpload> {
  if (file.size > MAX_FILE_BYTES) {
    throw new FileTooLargeError();
  }

  const chunkSize = Math.max(1, chunkSizeFor(file.size));
  const total = Math.max(1, Math.ceil(file.size / chunkSize));
  const ivs: string[] = [];
  const parts: Uint8Array[] = [];
  const blobParts: BlobPart[] = [];

  for (let index = 0; index < total; index += 1) {
    const slice = file.slice(index * chunkSize, (index + 1) * chunkSize);
    const plaintext = new Uint8Array(await slice.arrayBuffer());
    const { iv, ciphertext } = await sealBytes(key, plaintext);
    ivs.push(toBase64Url(iv));
    parts.push(ciphertext);
    blobParts.push(new Blob([ciphertext.slice()]));
    onProgress(((index + 1) / total) * 0.6);
  }

  const body = new Blob(blobParts, { type: "application/octet-stream" });

  const response = await fetch(ticket.uploadUrl, {
    method: "PUT",
    body,
    headers: {
      "content-type": "application/octet-stream",
      "x-husk-chunks": String(total),
    },
  });
  if (!response.ok) {
    throw new Error("Upload failed");
  }
  onProgress(1);

  return {
    objectKey: ticket.objectKey,
    chunks: total,
    ivs,
    lengths: parts.map((part) => part.byteLength),
  };
}

export async function downloadAndDecrypt(
  key: CryptoKey,
  pin: string,
  objectKey: string,
  ivs: readonly string[],
  lengths: readonly number[],
  mime: string,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const response = await fetch(
    `${WORKER_URL}/room/${pin}/object/${encodeURIComponent(objectKey)}`,
  );
  if (!response.ok) {
    throw new Error("Download failed");
  }
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  onProgress(0.5);

  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (let index = 0; index < ivs.length; index += 1) {
    const ivValue = ivs[index];
    const length = lengths[index];
    if (ivValue === undefined || length === undefined) {
      throw new Error("Missing chunk metadata");
    }
    const slice = ciphertext.subarray(offset, offset + length);
    offset += length;
    chunks.push(await openBytes(key, fromBase64Url(ivValue), slice));
    onProgress(0.5 + ((index + 1) / ivs.length) * 0.5);
  }

  return new Blob(
    chunks.map((chunk) => new Blob([chunk.slice()])),
    { type: mime },
  );
}
