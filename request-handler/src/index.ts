import "./env";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import express from "express";
import path from "path";

import { BUCKET_NAME, PORT } from "./env";

if (!process.env.AWS_ACCESS_KEY_ID && !process.env.AWS_PROFILE) {
  console.warn(
    "AWS credentials were not found in the environment. " +
      "The SDK will fall back to an instance profile if one exists."
  );
}

const s3Client = new S3Client({
  region: process.env.AWS_REGION ?? "ap-south-1",
});

const app = express();

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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * Resolves the deployment id from (in order):
 *  1. x-deployment-id header
 *  2. ?id=<id> query parameter  (handy on Windows, where *.localhost is flaky)
 *  3. /_deployments/<id>/... path prefix
 *  4. <id>.example.com subdomain
 */
function resolveRequest(req: express.Request): {
  id: string | null;
  pathname: string;
} {
  const headerId = req.get("x-deployment-id")?.trim();
  if (headerId) return { id: headerId, pathname: req.path };

  const queryId = req.query.id;
  if (typeof queryId === "string" && queryId.trim() !== "") {
    return { id: queryId.trim(), pathname: req.path };
  }

  const prefix = "/_deployments/";
  if (req.path.startsWith(prefix)) {
    const rest = req.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) return { id: rest, pathname: "/" };
    return { id: rest.slice(0, slash), pathname: rest.slice(slash) };
  }

  const host = (req.hostname || "").toLowerCase();
  const first = host.split(".")[0];
  if (first && !["localhost", "127", "www", "0"].includes(first)) {
    return { id: first, pathname: req.path };
  }

  return { id: null, pathname: req.path };
}

/**
 * Builds the S3 keys to try. Falls back to index.html for client-side routes
 * (e.g. /about -> dist/<id>/index.html), like Vercel does for SPAs.
 */
function buildKeys(id: string, rawPath: string): string[] {
  let pathname = rawPath;

  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // keep the raw value if it is not valid percent-encoding
  }

  pathname = pathname.replace(/\\/g, "/");
  pathname = path.posix.normalize(`/${pathname}`);

  const hadTrailingSlash = pathname.endsWith("/");
  if (hadTrailingSlash) pathname += "index.html";

  const base = `dist/${id}`;
  const hasExtension = path.posix.extname(pathname) !== "";
  const keys = [`${base}${pathname}`];

  if (!hasExtension) {
    keys.push(`${base}${pathname}/index.html`);
    keys.push(`${base}/index.html`);
  } else if (hadTrailingSlash) {
    // /some-route/ -> dist/<id>/some-route/index.html, then SPA fallback.
    keys.push(`${base}/index.html`);
  }

  return [...new Set(keys)];
}

function isNotFound(err: any): boolean {
  return (
    err?.name === "NoSuchKey" ||
    err?.name === "NotFound" ||
    err?.$metadata?.httpStatusCode === 404
  );
}

async function getObject(key: string) {
  try {
    return await s3Client.send(
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })
    );
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

app.use(async (req, res) => {
  const { id, pathname } = resolveRequest(req);

  if (!id) {
    res
      .status(400)
      .type("html")
      .send(
        `<!doctype html><h1>No deployment id</h1>
         <p>Use <code>http://&lt;id&gt;.localhost:${PORT}</code> or
         <code>http://localhost:${PORT}/?id=&lt;id&gt;</code>.</p>`
      );
    return;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    res.status(400).send("Invalid deployment id");
    return;
  }

  try {
    for (const key of buildKeys(id, pathname)) {
      const object = await getObject(key);
      if (!object) continue;

      const ext = path.posix.extname(key).toLowerCase();
      const storedType = object.ContentType;
      res.set(
        "Content-Type",
        storedType && storedType !== "application/octet-stream"
          ? storedType
          : mimeTypes[ext] ?? "application/octet-stream"
      );

      if (object.ContentLength != null) {
        res.set("Content-Length", String(object.ContentLength));
      }
      if (object.ETag) res.set("ETag", object.ETag);
      if (object.LastModified) {
        res.set("Last-Modified", object.LastModified.toUTCString());
      }

      // Hashed asset filenames never change, HTML must always revalidate.
      const isHashedAsset =
        key.includes("/assets/") || /\.[a-f0-9]{8,}\./i.test(key);
      res.set(
        "Cache-Control",
        isHashedAsset
          ? "public, max-age=31536000, immutable"
          : "no-cache"
      );

      if (req.method === "HEAD") {
        res.end();
        return;
      }

      const body: any = object.Body;
      if (body && typeof body.pipe === "function") {
        body.on("error", (err: unknown) => {
          console.error(`Error streaming ${key}:`, err);
          res.destroy();
        });
        body.pipe(res);
        return;
      }

      if (!body) {
        res.status(404).send("Not Found");
        return;
      }

      const byteArray = await body.transformToByteArray();
      res.send(Buffer.from(byteArray));
      return;
    }

    res
      .status(404)
      .type("html")
      .send(
        `<!doctype html><h1>404 - Not Found</h1>
         <p>No build output exists for deployment <code>${id}</code> yet.</p>
         <p>Check <code>GET /status?id=${id}</code> and
         <code>GET /logs?id=${id}</code> on the API.</p>`
      );
  } catch (err: any) {
    console.error(`Error serving ${pathname} for ${id}:`, err);
    res.status(500).send("Internal Server Error");
  }
});

app.listen(PORT, () => {
  console.log(`Request handler running on http://localhost:${PORT}`);
});
