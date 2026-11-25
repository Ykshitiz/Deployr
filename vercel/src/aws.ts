import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createReadStream } from "fs";
import path from "path";

import { BUCKET_NAME } from "./env";

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? "ap-south-1",
});

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/**
 * @param key      S3 object key, e.g. output/abc12/src/index.ts (forward slashes)
 * @param localFilePath absolute path on disk
 */
export const uploadFiles = async (key: string, localFilePath: string) => {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: createReadStream(localFilePath),
      ContentType:
        mimeTypes[path.extname(localFilePath).toLowerCase()] ??
        "application/octet-stream",
    })
  );
};
