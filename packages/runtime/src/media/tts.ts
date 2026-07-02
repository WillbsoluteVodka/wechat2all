import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface RuntimeVoiceArtifact {
  filePath: string;
  playtimeMs?: number;
  mimeType?: string;
  providerId: string;
  isDummy?: boolean;
}

export interface RuntimeTTSProvider {
  id: string;
  synthesize(params: {
    text: string;
    voice?: string;
    conversationId?: string;
  }): Promise<RuntimeVoiceArtifact>;
}

export interface DummyTTSProviderOptions {
  id?: string;
  outputDir?: string;
  playtimeMsPerChar?: number;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "tts";
}

export function createDummyTTSProvider(
  opts: DummyTTSProviderOptions = {},
): RuntimeTTSProvider {
  const id = opts.id ?? "dummy-tts";
  const outputDir = opts.outputDir ?? path.join(os.tmpdir(), "wechat2all-dummy-tts");
  const playtimeMsPerChar = opts.playtimeMsPerChar ?? 120;

  return {
    id,
    async synthesize(params) {
      await fs.mkdir(outputDir, { recursive: true });
      const digest = crypto
        .createHash("sha256")
        .update(`${params.conversationId ?? ""}:${params.voice ?? ""}:${params.text}`)
        .digest("hex")
        .slice(0, 12);
      const filePath = path.join(outputDir, `${safeFileName(digest)}.dummy-tts.txt`);
      await fs.writeFile(
        filePath,
        [
          "This is a dummy TTS artifact for runtime testing.",
          `voice=${params.voice ?? "default"}`,
          "",
          params.text,
        ].join("\n"),
        "utf-8",
      );
      return {
        filePath,
        playtimeMs: Math.max(500, params.text.length * playtimeMsPerChar),
        mimeType: "text/plain",
        providerId: id,
        isDummy: true,
      };
    },
  };
}
