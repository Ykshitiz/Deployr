import "./env";

import express from "express";
import cors from "cors";
import { simpleGit } from "simple-git";
import path from "path";
import fs from "fs/promises";
import { createClient } from "redis";

import { uploadFiles } from "./aws";
import { getAllFiles } from "./files";
import { generate, mapLimit } from "./utils";
import {
  PORT,
  REDIS_URL,
  REQUEST_HANDLER_BASE_URL,
  WORK_DIR,
} from "./env";

const app = express();

const publisher = createClient({ url: REDIS_URL });
const subscriber = createClient({ url: REDIS_URL });

publisher.on("error", (err) =>
  console.error("Redis Publisher Error:", err)
);
subscriber.on("error", (err) =>
  console.error("Redis Subscriber Error:", err)
);

app.use(cors());
app.use(express.json());

// Built React dashboard (frontend/dist). In development use Vite on :5173.
app.use(
  express.static(path.join(__dirname, "..", "..", "frontend", "dist"))
);

const TERMINAL_STATUSES = new Set(["built", "failed"]);

function deploymentUrls(id: string) {
  try {
    const base = new URL(REQUEST_HANDLER_BASE_URL);
    const port = base.port ? `:${base.port}` : "";

    return {
      url: `${base.origin}/?id=${encodeURIComponent(id)}`,
      subdomainUrl: `${base.protocol}//${id}.${base.hostname}${port}/`,
    };
  } catch {
    return {
      url: `${REQUEST_HANDLER_BASE_URL}/?id=${encodeURIComponent(id)}`,
      subdomainUrl: `${REQUEST_HANDLER_BASE_URL}/${id}`,
    };
  }
}

app.get("/", (_req, res) => {
  res
    .status(503)
    .type("html")
    .send(
      `<!doctype html><body style="font-family:system-ui;background:#000;color:#eee;padding:40px">
       <h1>Frontend not built</h1>
       <p>Run <code>npm --prefix frontend run dev</code> (or <code>npm run dev</code> from the repo root)
       and open <a style="color:#8ab4ff" href="http://localhost:5173">http://localhost:5173</a>.</p>
       <p>For a production build: <code>npm --prefix frontend run build</code>.</p>
       </body>`
    );
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/deploy", async (req, res) => {
  const repoUrl = req.body?.repoUrl;

  if (typeof repoUrl !== "string" || repoUrl.trim() === "") {
    res.status(400).json({ error: "repoUrl is required" });
    return;
  }

  const id = generate();
  const repoDir = path.join(WORK_DIR, id);
  const url = repoUrl.trim();
  const createdAt = new Date().toISOString();

  const log = async (message: string) => {
    console.log(`[${id}] ${message}`);
    await publisher
      .rPush(`logs:${id}`, `[${new Date().toISOString()}] ${message}`)
      .catch(() => undefined);
  };

  try {
    await publisher.hSet("status", id, "cloning");
    await publisher.hSet(`meta:${id}`, { repoUrl: url, createdAt });
    await publisher.zAdd("deployments", {
      score: Date.now(),
      value: id,
    });
    await log(`Cloning ${url}`);

    await fs.mkdir(WORK_DIR, { recursive: true });
    // --depth 1 keeps .git small; we do not need history for a build.
    await simpleGit().clone(url, repoDir, ["--depth", "1"]);

    const files = getAllFiles(repoDir);
    if (files.length === 0) {
      throw new Error("Repository is empty (no files were cloned)");
    }

    await publisher.hSet("status", id, "uploading");
    await log(`Uploading ${files.length} files to S3`);

    await mapLimit(files, 8, async (file) => {
      const relativePath = path
        .relative(repoDir, file)
        .split(path.sep)
        .join("/");
      await uploadFiles(`output/${id}/${relativePath}`, file);
    });

    // Set the status *before* pushing so the worker cannot report "building"
    // before "uploaded" has been written.
    await publisher.hSet("status", id, "uploaded");
    // Log before pushing so the worker's "Starting build" cannot appear
    // before "Queued for build" in the log list.
    await log("Queued for build");
    await publisher.lPush("build-queue", id);

    res.json({
      id,
      status: "uploaded",
      message: `Deploying from ${url} with id ${id}`,
      ...deploymentUrls(id),
    });
  } catch (err: any) {
    console.error(`[${id}] deploy failed`, err);
    await publisher.hSet("status", id, "failed").catch(() => undefined);
    await log(`Upload failed: ${err?.message ?? err}`).catch(() => undefined);
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => undefined);

    res.status(500).json({
      id,
      status: "failed",
      error: err?.message ?? "Deploy failed",
    });
  }
});

app.get("/deployments", async (_req, res) => {
  try {
    // Newest first, capped so a long-running instance stays fast.
    const ids = await subscriber.zRange("deployments", 0, 49, { REV: true });

    const deployments = await Promise.all(
      ids.map(async (id) => {
        const [status, meta] = await Promise.all([
          subscriber.hGet("status", id),
          subscriber.hGetAll(`meta:${id}`),
        ]);

        return {
          id,
          status: status ?? "unknown",
          repoUrl: meta.repoUrl ?? null,
          createdAt: meta.createdAt ?? null,
          ...deploymentUrls(id),
        };
      })
    );

    res.set("Cache-Control", "no-store");
    res.json({ deployments });
  } catch (err) {
    console.error("Error listing deployments", err);
    res.status(500).json({ error: "Internal server error listing deployments" });
  }
});

app.get("/status", async (req, res) => {
  const id = req.query.id;
  if (typeof id !== "string" || id === "") {
    res.status(400).json({ error: "Missing deployment id" });
    return;
  }

  try {
    const status = await subscriber.hGet("status", id);
    if (!status) {
      res.status(404).json({ id, status: null, error: "Unknown deployment id" });
      return;
    }
    res.json({ id, status });
  } catch (err) {
    console.error("Error reading status from Redis", err);
    res.status(500).json({ error: "Internal server error reading status" });
  }
});

app.get("/logs", async (req, res) => {
  const id = req.query.id;
  if (typeof id !== "string" || id === "") {
    res.status(400).json({ error: "Missing deployment id" });
    return;
  }

  try {
    const logs = await subscriber.lRange(`logs:${id}`, 0, -1);
    res.json({ id, logs });
  } catch (err) {
    console.error("Error reading logs from Redis", err);
    res.status(500).json({ error: "Internal server error reading logs" });
  }
});

/**
 * Server-Sent Events stream of build logs + status transitions.
 *
 * Sends:
 *   event: log      data: "<one log line>"
 *   event: status   data: "building" | "built" | "failed" | ...
 *   event: done     data: "built" | "failed"
 *   event: failure  data: "<message>"
 */
app.get("/logs/stream", async (req, res) => {
  const id = req.query.id;

  if (typeof id !== "string" || id === "") {
    res.status(400).json({ error: "Missing deployment id" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  let cursor = 0;
  let lastStatus: string | null = null;
  let terminalSince: number | null = null;
  let finished = false;
  let timer: NodeJS.Timeout | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    if (heartbeat) clearInterval(heartbeat);
    res.end();
  };

  const send = (event: string, data: unknown) => {
    if (finished || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tick = async () => {
    if (finished) return;

    try {
      const [lines, status] = await Promise.all([
        subscriber.lRange(`logs:${id}`, cursor, -1),
        subscriber.hGet("status", id),
      ]);

      if (lines.length > 0) {
        cursor += lines.length;
        for (const line of lines) send("log", line);
      }

      if (status && status !== lastStatus) {
        lastStatus = status;
        send("status", status);
      }

      if (status && TERMINAL_STATUSES.has(status)) {
        terminalSince ??= Date.now();
      } else {
        terminalSince = null;
      }

      // Wait a moment after the terminal status so the worker's final batch
      // of batched log lines is flushed before the stream closes.
      if (terminalSince && Date.now() - terminalSince > 1500) {
        send("done", status ?? "done");
        cleanup();
      }
    } catch (err) {
      console.error(`SSE error for ${id}`, err);
      send("failure", "Failed to read logs from Redis");
      cleanup();
    }
  };

  try {
    const status = await subscriber.hGet("status", id);

    if (!status) {
      send("failure", "Unknown deployment id");
      cleanup();
      return;
    }

    lastStatus = status;
    send("status", status);

    await tick();

    timer = setInterval(() => void tick(), 500);
    heartbeat = setInterval(() => {
      if (!finished) res.write(": keep-alive\n\n");
    }, 15_000);
    req.on("close", cleanup);
  } catch (err) {
    console.error(`Failed to open log stream for ${id}`, err);
    send("failure", "Internal server error");
    cleanup();
  }
});

async function start() {
  try {
    if (!publisher.isOpen) await publisher.connect();
    if (!subscriber.isOpen) await subscriber.connect();

    app.listen(PORT, () =>
      console.log(`API + dashboard on http://localhost:${PORT}`)
    );
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
}

start();
