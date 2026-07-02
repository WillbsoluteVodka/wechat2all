/**
 * Download and optionally decrypt media from the WeChat CDN.
 */
import { decryptAesEcb } from "./aes-ecb.js";
import { buildCdnDownloadUrl } from "./cdn-url.js";

const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface CdnDownloadOptions {
  /** Download timeout in ms. */
  timeoutMs?: number;
  /** Optional caller cancellation signal. */
  signal?: AbortSignal;
}

function makeTimeoutSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timeoutReached = false;
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);

  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
    timedOut: () => timeoutReached,
  };
}

/**
 * Download raw bytes from the CDN (no decryption).
 */
async function fetchCdnBytes(
  url: string,
  options: CdnDownloadOptions = {},
): Promise<Buffer> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  const timeout = makeTimeoutSignal(timeoutMs, options.signal);
  try {
    const res = await fetch(url, { signal: timeout.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "(unreadable)");
      throw new Error(`CDN download ${res.status} ${res.statusText}: ${body}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    if (timeout.timedOut()) {
      throw new Error(`CDN download timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    timeout.cleanup();
  }
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings are observed:
 *   - base64(raw 16 bytes)           -> images (aes_key from media field)
 *   - base64(hex string of 16 bytes) -> file / voice / video
 *
 * In the second case, base64-decoding yields 32 ASCII hex chars which must
 * then be parsed as hex to recover the actual 16-byte key.
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (
    decoded.length === 32 &&
    /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))
  ) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(
    `aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`,
  );
}

/**
 * Download and AES-128-ECB decrypt a CDN media file. Returns plaintext Buffer.
 */
export async function downloadAndDecrypt(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  options?: CdnDownloadOptions,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64);
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  const encrypted = await fetchCdnBytes(url, options);
  return decryptAesEcb(encrypted, key);
}

/**
 * Download plain (unencrypted) bytes from the CDN.
 */
export async function downloadPlain(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  options?: CdnDownloadOptions,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  return fetchCdnBytes(url, options);
}
