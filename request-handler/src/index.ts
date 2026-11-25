
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import express from "express";
import path from "path";

const bucket = process.env.AWS_BUCKET_NAME || "vercel-bucket-test62";
const region = process.env.AWS_REGION || "ap-south-1";

if (
  !process.env.AWS_ACCESS_KEY_ID ||
  !process.env.AWS_SECRET_ACCESS_KEY ||
  !bucket
) {
  throw new Error("Missing required environment variables");
}

const s3Client = new S3Client({ region });
const app = express();

const mimeTypes: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain",
};

app.use(async (req, res) => {
  const host = req.hostname;
  const id = host.split(".")[0];
  const filePath = req.path === "/" ? "/index.html" : req.path;

  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: `dist/${id}${filePath}`,
    });

    const response = await s3Client.send(command);
    if (!response.Body) {
      res.status(404).send("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      response.ContentType || mimeTypes[ext] || "application/octet-stream";

    res.set("Content-Type", contentType);
    const byteArray = await response.Body.transformToByteArray();
    res.send(Buffer.from(byteArray));
  } catch (err: any) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      res.status(404).send("Not Found");
    } else {
      console.error(`Error fetching file dist/${id}${filePath}:`, err);
      res.status(500).send("Internal Server Error");
    }
  }
});

app.listen(3001, () => {
  console.log("Request handler running on http://localhost:3001");
});
