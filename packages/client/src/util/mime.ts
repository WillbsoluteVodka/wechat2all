import path from "node:path";

const EXTENSION_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".xml": "application/xml",
  ".html": "text/html",
  ".md": "text/markdown",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".amr": "audio/amr",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".silk": "audio/silk",
  ".spx": "audio/speex",
  ".wav": "audio/wav",
  ".pcm": "audio/L16",
  ".flac": "audio/flac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".caf": "audio/x-caf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/amr": ".amr",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/silk": ".silk",
  "audio/speex": ".spx",
  "audio/wav": ".wav",
  "audio/l16": ".pcm",
  "audio/flac": ".flac",
  "audio/aiff": ".aiff",
  "audio/x-caf": ".caf",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/x-tar": ".tar",
  "application/gzip": ".gz",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "application/json": ".json",
  "application/x-ndjson": ".jsonl",
  "application/xml": ".xml",
  "text/html": ".html",
  "text/markdown": ".md",
  "application/yaml": ".yaml",
};

/** Get MIME type from filename extension. Defaults to "application/octet-stream". */
export function getMimeFromFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

/** Get file extension from MIME type. Defaults to ".bin". */
export function getExtensionFromMime(mimeType: string): string {
  const ct = mimeType.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXTENSION[ct] ?? ".bin";
}

/** Get file extension from Content-Type header or URL path. Defaults to ".bin". */
export function getExtensionFromContentTypeOrUrl(
  contentType: string | null,
  url: string,
): string {
  if (contentType) {
    const ext = getExtensionFromMime(contentType);
    if (ext !== ".bin") return ext;
  }
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  const knownExts = new Set(Object.keys(EXTENSION_TO_MIME));
  return knownExts.has(ext) ? ext : ".bin";
}
