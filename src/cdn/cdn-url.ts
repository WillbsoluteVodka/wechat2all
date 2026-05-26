/**
 * CDN URL construction for WeChat CDN upload/download.
 */

/** Build a CDN download URL from encrypt_query_param. */
export function buildCdnDownloadUrl(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** Build a CDN upload URL from upload_param/filekey or a prebuilt full URL. */
export function buildCdnUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam?: string;
  uploadFullUrl?: string;
  filekey?: string;
}): string {
  if (params.uploadFullUrl) {
    return params.uploadFullUrl;
  }

  if (!params.uploadParam || !params.filekey) {
    throw new Error(
      "buildCdnUploadUrl requires either uploadFullUrl or both uploadParam and filekey",
    );
  }

  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}
