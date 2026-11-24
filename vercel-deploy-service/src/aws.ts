import {S3Client,ListObjectsV2Command,ListObjectsV2CommandOutput,GetObjectCommand,} from "@aws-sdk/client-s3";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "ap-south-1",
//   credentials: {
//     accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
//     secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
//   },
});

const BUCKET_NAME = process.env.AWS_BUCKET_NAME; // Update with your bucket name

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

      // Saves locally to <project-root>/dist/<prefix>/... (matching standard Vercel clone structure)
      const localFilePath = path.join(__dirname, item.Key);
      await mkdir(path.dirname(localFilePath), { recursive: true });

      const byteArray = await getResponse.Body.transformToByteArray();
      await writeFile(localFilePath, byteArray);
    });

    await Promise.all(downloadPromises);
    console.log(
        `Downloaded ${downloadPromises.length} files from S3 folder: ${prefix}`
    )
    continuationToken = listResponse.NextContinuationToken;
  } while (continuationToken);
}
