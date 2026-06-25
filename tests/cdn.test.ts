import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  downloadPlain,
  parseAesKey,
  uploadBufferToCdn,
} from "../src/index.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

test("parseAesKey accepts raw-key and hex-string encodings", () => {
  const raw = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  assert.deepEqual(parseAesKey(raw.toString("base64")), raw);
  assert.deepEqual(
    parseAesKey(Buffer.from(raw.toString("hex"), "ascii").toString("base64")),
    raw,
  );
});

test("uploadBufferToCdn retries transient server errors", async () => {
  let calls = 0;
  mockFetch(() => {
    calls++;
    if (calls === 1) {
      return new Response("temporary", { status: 500 });
    }
    return new Response("", {
      status: 200,
      headers: { "x-encrypted-param": "download-param" },
    });
  });

  const result = await uploadBufferToCdn({
    buf: Buffer.from("hello"),
    uploadFullUrl: "https://cdn.example/upload",
    filekey: "file-key",
    cdnBaseUrl: "https://cdn.example/c2c",
    aeskey: Buffer.alloc(16, 1),
    options: {
      timeoutMs: 1_000,
      retryDelayMs: 0,
      maxRetries: 2,
    },
  });

  assert.equal(calls, 2);
  assert.equal(result.downloadParam, "download-param");
});

test("downloadPlain returns CDN bytes", async () => {
  mockFetch((url) => {
    assert.match(url, /encrypted_query_param=abc/);
    return new Response(Buffer.from("plain bytes"), { status: 200 });
  });

  const data = await downloadPlain("abc", "https://cdn.example/c2c");
  assert.equal(data.toString("utf-8"), "plain bytes");
});
