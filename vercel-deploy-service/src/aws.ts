import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";

import {
  BUCKET_NAME,
  UPLOAD_CONCURRENCY,
  WORK_DIR,
} from "./env";
import { getAllFiles, mapLimit, type Logger } from "./utils";

const s3Client = new S3Client({
  region: process.env.AWS_REGION ?? "ap-south-1",
});

/**
 * Downloads every object under output/<id>/ from S3 into WORK_DIR/<id>.
 * Returns the local folder that now contains the repo.
 */
export async function downloadS3Folder(
  id: string,
  onLog: Logger = () => undefined
): Promise<string> {
  const prefix = `output/${id}/`;
  const jobDir = path.resolve(WORK_DIR, id);

  // Always start from a clean folder: leftover files from an earlier attempt
  // can hide real failures (e.g. a stale dist/ from a previous build).
  await rm(jobDir, { recursive: true, force: true });
  await mkdir(jobDir, { recursive: true });

  let continuationToken: string | undefined;
  let downloaded = 0;

  do {
    const listResponse = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = (listResponse.Contents ?? []).filter(
      (item) => item.Key && !item.Key.endsWith("/")
    );

    await mapLimit(objects, UPLOAD_CONCURRENCY, async (item) => {
      const key = item.Key!;
      const relativePath = key.slice(prefix.length);

      const localFilePath = path.resolve(jobDir, relativePath);
      // Defensive: never let an S3 key escape the job folder.
      if (
        localFilePath !== jobDir &&
        !localFilePath.startsWith(jobDir + path.sep)
      ) {
        onLog(`Skipping suspicious key: ${key}`);
        return;
      }

      const getResponse = await s3Client.send(
        new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })
      );
      if (!getResponse.Body) return;

      await mkdir(path.dirname(localFilePath), { recursive: true });
      const byteArray = await getResponse.Body.transformToByteArray();
      await writeFile(localFilePath, byteArray);
      downloaded++;
    });

    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);

  if (downloaded === 0) {
    throw new Error(
      `No files found in s3://${BUCKET_NAME}/${prefix}. ` +
        `The upload step probably failed or used a different id.`
    );
  }

  onLog(`Downloaded ${downloaded} files from s3://${BUCKET_NAME}/${prefix}`);
  return jobDir;
}

const getContentType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
  };
  return mimeTypes[ext] ?? "application/octet-stream";
};

async function uploadFile(key: string, localFilePath: string): Promise<void> {
  const fileContent = await readFile(localFilePath);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileContent,
      ContentType: getContentType(localFilePath),
    })
  );
}

/**
 * Uploads the static build output to dist/<id>/... in S3. That prefix is what
 * request-handler reads from.
 */
export async function copyFinalDist(
  id: string,
  buildOutputDir: string,
  onLog: Logger = () => undefined
): Promise<number> {
  const allFiles = getAllFiles(buildOutputDir);

  if (allFiles.length === 0) {
    throw new Error(`Build output folder is empty: ${buildOutputDir}`);
  }

  await mapLimit(allFiles, UPLOAD_CONCURRENCY, async (file) => {
    const relativePath = path
      .relative(buildOutputDir, file)
      .split(path.sep)
      .join("/");

    await uploadFile(`dist/${id}/${relativePath}`, file);
  });

  onLog(`Uploaded ${allFiles.length} built files to dist/${id}/`);
  return allFiles.length;
}
