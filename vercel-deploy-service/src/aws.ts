import {
  S3Client,
  ListObjectsV2Command,
  ListObjectsV2CommandOutput,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { mkdir, writeFile, readFile } from "fs/promises";
import fs from "fs";
import path from "path";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "ap-south-1",
});

const BUCKET_NAME = process.env.AWS_BUCKET_NAME || "vercel-bucket-test62";

export async function downloadS3Folder(prefix: string) {
  let continuationToken: string | undefined = undefined;

  do {
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    });

    const listResponse: ListObjectsV2CommandOutput = await s3Client.send(
      listCommand
    );

    if (!listResponse.Contents || listResponse.Contents.length === 0) {
      return;
    }

    const downloadPromises = listResponse.Contents.map(async (item) => {
      if (!item.Key || item.Key.endsWith("/")) return;

      const getCommand = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: item.Key,
      });

      const getResponse = await s3Client.send(getCommand);
      if (!getResponse.Body) return;

      const localFilePath = path.join(__dirname, item.Key);
      await mkdir(path.dirname(localFilePath), { recursive: true });

      const byteArray = await getResponse.Body.transformToByteArray();
      await writeFile(localFilePath, byteArray);
    });

    await Promise.all(downloadPromises);
    console.log(
      `Downloaded ${downloadPromises.length} files from S3 folder: ${prefix}`
    );
    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);
}

export async function copyFinalDist(id: string) {
  const folderPath = path.join(__dirname, `output/${id}/dist`);
  const allFiles = getAllFiles(folderPath);

  await Promise.all(
    allFiles.map((file) => {
      const relativePath = path
        .relative(folderPath, file)
        .split(path.sep)
        .join("/");
      return uploadFile(`dist/${id}/${relativePath}`, file);
    })
  );
  console.log(`Uploaded ${allFiles.length} built files for job: ${id}`);
}

const getAllFiles = (folderPath: string): string[] => {
  let response: string[] = [];

  const allFilesAndFolders = fs.readdirSync(folderPath);
  allFilesAndFolders.forEach((file) => {
    const fullFilePath = path.join(folderPath, file);
    if (fs.statSync(fullFilePath).isDirectory()) {
      response = response.concat(getAllFiles(fullFilePath));
    } else {
      response.push(fullFilePath);
    }
  });
  return response;
};

const getContentType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  return mimeTypes[ext] || "application/octet-stream";
};

const uploadFile = async (fileName: string, localFilePath: string) => {
  const fileContent = await readFile(localFilePath);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: fileName,
      Body: fileContent,
      ContentType: getContentType(localFilePath),
    })
  );
  console.log(`Uploaded: ${fileName}`);
};
