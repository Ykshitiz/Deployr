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
import { PORT, REDIS_URL, WORK_DIR } from "./env";

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

app.get("/", (req, res) => {
  req.query.name ? res.send(`Hello ${req.query.name}`) : res.send("Hello World");
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

  const log = async (message: string) => {
    console.log(`[${id}] ${message}`);
    await publisher
      .rPush(`logs:${id}`, `[${new Date().toISOString()}] ${message}`)
      .catch(() => undefined);
  };

  try {
    await publisher.hSet("status", id, "cloning");
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

async function start() {
  try {
    if (!publisher.isOpen) await publisher.connect();
    if (!subscriber.isOpen) await subscriber.connect();

    app.listen(PORT, () =>
      console.log(`API listening on http://localhost:${PORT}`)
    );
  } catch (err) {
    console.error("Startup error:", err);
    process.exit(1);
  }
}

start();
