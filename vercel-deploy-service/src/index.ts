import "./env";

import path from "path";
import { rm } from "fs/promises";
import { createClient } from "redis";

import { copyFinalDist, downloadS3Folder } from "./aws";
import {
  buildProject,
  findBuildOutput,
  findProjectRoot,
  installDependencies,
} from "./utils";
import { KEEP_BUILD, REDIS_URL } from "./env";

const publisher = createClient({ url: REDIS_URL });
publisher.on("error", (err) =>
  console.error("Redis Publisher Error:", err)
);

const blockingClient = createClient({ url: REDIS_URL });
blockingClient.on("error", (err) =>
  console.error("Redis Blocking Client Error:", err)
);

/**
 * Console + Redis logger. Lines are batched so a noisy `npm install` does not
 * turn into thousands of individual Redis round-trips.
 */
function createJobLogger(id: string) {
  const buffer: string[] = [];
  let timer: NodeJS.Timeout | null = null;

  const flush = async () => {
    if (buffer.length === 0) return;
    const lines = buffer.splice(0, buffer.length);

    try {
      await publisher.rPush(`logs:${id}`, lines);
      // Keep only the last 1000 lines per deployment.
      await publisher.lTrim(`logs:${id}`, -1000, -1);
    } catch (err) {
      console.error(`[${id}] failed to push logs to Redis`, err);
    }
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      await flush();
    }, 400);
    timer.unref?.();
  };

  return {
    log(line: string) {
      console.log(`[${id}] ${line}`);
      buffer.push(`[${new Date().toISOString()}] ${line}`);
      schedule();
    },
    async close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await flush();
    },
  };
}

async function runJob(id: string): Promise<void> {
  const logger = createJobLogger(id);
  const log = (line: string) => logger.log(line);

  try {
    await publisher.hSet("status", id, "building");
    log("Starting build");

    const jobDir = await downloadS3Folder(id, log);
    const projectRoot = findProjectRoot(jobDir);
    log(
      `Project root: ${
        path.relative(jobDir, projectRoot) || "."
      } (relative to the repo)`
    );

    log("Installing dependencies");
    await installDependencies(projectRoot, log);

    log("Building project");
    await buildProject(projectRoot, log);

    const buildOutputDir = findBuildOutput(projectRoot);
    log(`Using build output: ${path.relative(projectRoot, buildOutputDir)}`);

    await copyFinalDist(id, buildOutputDir, log);

    await publisher.hSet("status", id, "built");
    log(`Deployment ready: http://${id}.localhost:3001`);

    if (!KEEP_BUILD) {
      await rm(jobDir, { recursive: true, force: true });
      log("Removed local build files");
    }
  } catch (err: any) {
    console.error(`[${id}] build failed`, err);
    log(`Build failed: ${err?.message ?? err}`);
    await publisher
      .hSet("status", id, "failed")
      .catch((redisErr) =>
        console.error(`[${id}] failed to set status`, redisErr)
      );
  } finally {
    await logger.close();
  }
}

let shuttingDown = false;

async function main() {
  await publisher.connect();
  await blockingClient.connect();

  console.log("Build worker connected to Redis, waiting for jobs...");

  while (!shuttingDown) {
    let response: Awaited<ReturnType<typeof blockingClient.brPop>> = null;

    try {
      // A finite timeout lets the loop notice SIGINT/SIGTERM.
      response = await blockingClient.brPop("build-queue", 5);
    } catch (err) {
      if (shuttingDown) break;
      console.error("BRPOP failed, retrying in 2s", err);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    if (!response?.element) continue;

    const id = response.element.trim();
    if (id === "") {
      console.log("Received empty id, skipping");
      continue;
    }

    console.log(`Picked up job ${id}`);
    await runJob(id);
  }

  await blockingClient.quit().catch(() => undefined);
  await publisher.quit().catch(() => undefined);
  console.log("Worker stopped");
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down after the current job...`);

  // brPop with a 5s timeout returns shortly; force-exit if Redis is gone.
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

main().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
