import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  MessageItemType,
  UploadMediaType,
  VoiceEncodeType,
  downloadMediaFromItem,
  sendVoice,
  uploadVoice,
} from "../src/index.js";
import type { ApiClient, SendMessageReq, GetUploadUrlReq } from "../src/index.js";

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

test("sendVoice builds a native voice message payload", async () => {
  let sent: SendMessageReq | undefined;
  const api = {
    async sendMessage(req: SendMessageReq): Promise<void> {
      sent = req;
    },
  } as unknown as ApiClient;

  const clientId = await sendVoice(
    api,
    "user",
    {
      filekey: "file-key",
      downloadEncryptedQueryParam: "download-param",
      aeskey: "00112233445566778899aabbccddeeff",
      fileSize: 123,
      fileSizeCiphertext: 128,
    },
    "ctx",
    {
      playtimeMs: 1200,
      encodeType: VoiceEncodeType.SILK,
      sampleRate: 24_000,
    },
  );

  assert.ok(clientId);
  assert.equal(sent?.msg?.to_user_id, "user");
  assert.equal(sent?.msg?.context_token, "ctx");
  const item = sent?.msg?.item_list?.[0];
  assert.equal(item?.type, MessageItemType.VOICE);
  assert.equal(item?.voice_item?.playtime, 1200);
  assert.equal(item?.voice_item?.encode_type, VoiceEncodeType.SILK);
  assert.equal(item?.voice_item?.sample_rate, 24_000);
  assert.equal(item?.voice_item?.media?.encrypt_query_param, "download-param");
});

test("uploadVoice requests VOICE media upload", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-ilink-test-"));
  const filePath = path.join(dir, "voice.silk");
  await fs.writeFile(filePath, Buffer.from("voice-bytes"));

  let uploadReq: GetUploadUrlReq | undefined;
  const api = {
    async getUploadUrl(req: GetUploadUrlReq) {
      uploadReq = req;
      return { upload_full_url: "https://cdn.example/upload" };
    },
  } as unknown as ApiClient;

  mockFetch(() => new Response("", {
    status: 200,
    headers: { "x-encrypted-param": "download-param" },
  }));

  const uploaded = await uploadVoice({
    filePath,
    toUserId: "user",
    api,
    cdnBaseUrl: "https://cdn.example/c2c",
    options: { retryDelayMs: 0 },
  });

  assert.equal(uploadReq?.media_type, UploadMediaType.VOICE);
  assert.equal(uploadReq?.to_user_id, "user");
  assert.equal(uploaded.downloadEncryptedQueryParam, "download-param");
});

test("downloadMediaFromItem falls back to image thumb media", async () => {
  mockFetch((url) => {
    assert.match(url, /encrypted_query_param=thumb-param/);
    return new Response(Buffer.from("thumb-bytes"), { status: 200 });
  });

  const downloaded = await downloadMediaFromItem(
    {
      type: MessageItemType.IMAGE,
      image_item: {
        thumb_media: {
          encrypt_query_param: "thumb-param",
        },
      },
    },
    "https://cdn.example/c2c",
  );

  assert.equal(downloaded?.kind, "image");
  assert.equal(downloaded?.data.toString("utf-8"), "thumb-bytes");
});
