/**
 * Upload encrypted media to the WeChat CDN.
 */
import { encryptAesEcb } from "./aes-ecb.js";
import { buildCdnUploadUrl } from "./cdn-url.js";

const UPLOAD_MAX_RETRIES = 3;
const UPLOAD_TIMEOUT_MS = 60_000;
const UPLOAD_RETRY_DELAY_MS = 1_000;

export interface CdnUploadOptions {
  /** Per-attempt upload timeout in ms. */
  timeoutMs?: number;
  /** Maximum upload attempts. Client-side 4xx errors are not retried. */
  maxRetries?: number;
  /** Delay between retriable attempts in ms. */
  retryDelayMs?: number;
  /** Optional caller cancellation signal. */
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
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
 * Upload one buffer to the WeChat CDN with AES-128-ECB encryption.
 * Returns the download encrypted_query_param from the CDN `x-encrypted-param` header.
 */
export async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam?: string;
  uploadFullUrl?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
  options?: CdnUploadOptions;
}): Promise<{ downloadParam: string }> {
  const {
    buf,
    uploadParam,
    uploadFullUrl,
    filekey,
    cdnBaseUrl,
    aeskey,
    options = {},
  } = params;
  const ciphertext = encryptAesEcb(buf, aeskey);
  const cdnUrl = buildCdnUploadUrl({
    cdnBaseUrl,
    uploadParam,
    uploadFullUrl,
    filekey,
  });
  const maxRetries = Math.max(1, Math.floor(options.maxRetries ?? UPLOAD_MAX_RETRIES));
  const timeoutMs = Math.max(1, options.timeoutMs ?? UPLOAD_TIMEOUT_MS);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? UPLOAD_RETRY_DELAY_MS);

  let downloadParam: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (options.signal?.aborted) {
      throw new Error("CDN upload aborted");
    }

    const timeout = makeTimeoutSignal(timeoutMs, options.signal);
    try {
      const res = await fetch(cdnUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
        signal: timeout.signal,
      });

      if (res.status >= 400 && res.status < 500) {
        const errMsg =
          res.headers.get("x-error-message") ?? (await res.text());
        throw new Error(`CDN upload client error ${res.status}: ${errMsg}`);
      }
      if (res.status !== 200) {
        const errMsg =
          res.headers.get("x-error-message") ?? `status ${res.status}`;
        throw new Error(`CDN upload server error: ${errMsg}`);
      }

      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) {
        throw new Error(
          "CDN upload response missing x-encrypted-param header",
        );
      }
      break;
    } catch (err) {
      if (options.signal?.aborted) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      lastError =
        timeout.timedOut()
          ? new Error(`CDN upload timed out after ${timeoutMs}ms`)
          : err;
      if (
        err instanceof Error &&
        err.message.includes("client error")
      ) {
        throw err;
      }
      if (attempt >= maxRetries) {
        break;
      }
      await sleep(retryDelayMs, options.signal);
    } finally {
      timeout.cleanup();
    }
  }

  if (!downloadParam) {
    throw lastError instanceof Error
      ? lastError
      : new Error(
          `CDN upload failed after ${maxRetries} attempts`,
        );
  }
  return { downloadParam };
}
