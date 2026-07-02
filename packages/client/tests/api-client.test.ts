import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { ApiClient, WeChatApiError, WeChatClient } from "../src/index.js";

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

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

test("sendMessage throws structured WeChatApiError on ret failure", async () => {
  mockFetch(() => jsonResponse({ ret: -1, errmsg: "bad request" }));

  const api = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
  });

  await assert.rejects(
    () => api.sendMessage({ msg: { to_user_id: "user" } }),
    (err) => {
      assert.ok(err instanceof WeChatApiError);
      assert.equal(err.endpoint, "ilink/bot/sendmessage");
      assert.equal(err.ret, -1);
      assert.equal(err.errmsg, "bad request");
      return true;
    },
  );
});

test("getConfig wraps invalid JSON in WeChatApiError", async () => {
  mockFetch(() => new Response("not-json", { status: 200 }));

  const api = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
  });

  await assert.rejects(
    () => api.getConfig("user"),
    (err) => {
      assert.ok(err instanceof WeChatApiError);
      assert.equal(err.endpoint, "ilink/bot/getconfig");
      assert.equal(err.responseBody, "not-json");
      return true;
    },
  );
});

test("regular API timeouts throw structured WeChatApiError", async () => {
  mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  }));

  const api = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
    apiTimeoutMs: 1,
  });

  await assert.rejects(
    () => api.sendMessage({ msg: { to_user_id: "user" } }),
    (err) => {
      assert.ok(err instanceof WeChatApiError);
      assert.equal(err.endpoint, "ilink/bot/sendmessage");
      assert.equal(err.timedOut, true);
      return true;
    },
  );
});

test("getUpdates timeout returns an empty long-poll response", async () => {
  mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("aborted", "AbortError"));
    });
  }));

  const api = new ApiClient({
    baseUrl: "https://api.example",
    token: "token",
  });

  const resp = await api.getUpdates("cursor", 1);
  assert.deepEqual(resp, {
    ret: 0,
    msgs: [],
    get_updates_buf: "cursor",
  });
});

test("WeChatClient.login stores token, normalized accountId, and returned baseUrl", async () => {
  mockFetch((url) => {
    if (url.includes("get_bot_qrcode")) {
      return jsonResponse({
        qrcode: "qr-id",
        qrcode_img_content: "https://qr.example/image",
      });
    }
    if (url.includes("get_qrcode_status")) {
      return jsonResponse({
        status: "confirmed",
        bot_token: "new-token",
        ilink_bot_id: "ABC@im.bot",
        baseurl: "https://new-base.example",
        ilink_user_id: "scanner",
      });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  const client = new WeChatClient({ baseUrl: "https://old-base.example" });
  const result = await client.login({ timeoutMs: 5_000 });

  assert.equal(result.connected, true);
  assert.equal(client.getAccountId(), "abc-im-bot");
  assert.deepEqual(client.getCredentials(), {
    accountId: "abc-im-bot",
    token: "new-token",
    baseUrl: "https://new-base.example",
  });
});
