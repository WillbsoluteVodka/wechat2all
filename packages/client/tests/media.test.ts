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
  encryptAesEcb,
  sendMediaFile,
  sendVoice,
  uploadVoice,
} from "../src/index.js";
import type {
  ApiClient,
  GetUploadUrlReq,
  MessageItem,
  SendMessageReq,
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

test("downloadMediaFromItem retries transient CDN failures", async () => {
  let attempts = 0;
  mockFetch(() => {
    attempts += 1;
    if (attempts === 1) {
      return new Response("temporary", { status: 503 });
    }
    return new Response(Buffer.from("image-bytes"), { status: 200 });
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
    { maxRetries: 2, retryDelayMs: 0 },
  );

  assert.equal(attempts, 2);
  assert.equal(downloaded?.data.toString("utf-8"), "image-bytes");
});

test("downloadMediaFromItem does not retry permanent CDN client errors", async () => {
  let attempts = 0;
  mockFetch(() => {
    attempts += 1;
    return new Response("missing", { status: 404 });
  });

  await assert.rejects(
    () => downloadMediaFromItem(
      {
        type: MessageItemType.IMAGE,
        image_item: {
          thumb_media: {
            encrypt_query_param: "missing-param",
          },
        },
      },
      "https://cdn.example/c2c",
      { maxRetries: 3, retryDelayMs: 0 },
    ),
    /CDN download 404/,
  );
  assert.equal(attempts, 1);
});

test("downloadMediaFromItem decrypts inbound file, video, and voice media", async () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plaintext = Buffer.from("downloaded-media");
  const ciphertext = encryptAesEcb(plaintext, key);
  const wireKey = Buffer.from(key.toString("hex"), "ascii").toString("base64");
  mockFetch(() => new Response(ciphertext, { status: 200 }));

  const cases: Array<{
    expectedKind: "file" | "video" | "voice";
    item: MessageItem;
  }> = [
    {
      expectedKind: "file",
      item: {
        type: MessageItemType.FILE,
        file_item: {
          file_name: "report.pdf",
          media: { encrypt_query_param: "file-param", aes_key: wireKey },
        },
      },
    },
    {
      expectedKind: "video",
      item: {
        type: MessageItemType.VIDEO,
        video_item: {
          media: { encrypt_query_param: "video-param", aes_key: wireKey },
        },
      },
    },
    {
      expectedKind: "voice",
      item: {
        type: MessageItemType.VOICE,
        voice_item: {
          media: { encrypt_query_param: "voice-param", aes_key: wireKey },
        },
      },
    },
  ];

  for (const testCase of cases) {
    const downloaded = await downloadMediaFromItem(
      testCase.item,
      "https://cdn.example/c2c",
    );
    assert.equal(downloaded?.kind, testCase.expectedKind);
    assert.deepEqual(downloaded?.data, plaintext);
  }
});

test("sendMediaFile routes images, videos, and generic files to native WeChat items", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat-ilink-send-media-"));
  const cases = [
    {
      fileName: "photo.png",
      uploadType: UploadMediaType.IMAGE,
      itemType: MessageItemType.IMAGE,
    },
    {
      fileName: "clip.mp4",
      uploadType: UploadMediaType.VIDEO,
      itemType: MessageItemType.VIDEO,
    },
    {
      fileName: "report.pdf",
      uploadType: UploadMediaType.FILE,
      itemType: MessageItemType.FILE,
    },
  ];

  mockFetch(() => new Response("", {
    status: 200,
    headers: { "x-encrypted-param": "download-param" },
  }));

  for (const testCase of cases) {
    const filePath = path.join(dir, testCase.fileName);
    await fs.writeFile(filePath, Buffer.from(`content-${testCase.fileName}`));
    let uploadReq: GetUploadUrlReq | undefined;
    let sent: SendMessageReq | undefined;
    const api = {
      cdnBaseUrl: "https://cdn.example/c2c",
      async getUploadUrl(req: GetUploadUrlReq) {
        uploadReq = req;
        return { upload_full_url: "https://cdn.example/upload" };
      },
      async sendMessage(req: SendMessageReq): Promise<void> {
        sent = req;
      },
    } as unknown as ApiClient;

    await sendMediaFile(api, "user", filePath, "ctx", undefined, {
      retryDelayMs: 0,
    });

    assert.equal(uploadReq?.media_type, testCase.uploadType);
    assert.equal(sent?.msg?.item_list?.[0]?.type, testCase.itemType);
    assert.equal(sent?.msg?.context_token, "ctx");
    if (testCase.itemType === MessageItemType.FILE) {
      assert.equal(sent?.msg?.item_list?.[0]?.file_item?.file_name, "report.pdf");
    }
  }
});
