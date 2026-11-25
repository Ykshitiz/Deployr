import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

import { BUILD_TIMEOUT_MS } from "./env";

export type Logger = (line: string) => void;

const SKIP_DIRS = new Set([".git", "node_modules"]);

/** Runs `fn` over `items` with at most `limit` promises in flight. */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;

  const workers = Array.from(
    { length: Math.min(Math.max(limit, 1), items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        await fn(items[index], index);
      }
    }
  );

  await Promise.all(workers);
}

export const getAllFiles = (folderPath: string): string[] => {
  let response: string[] = [];

  for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
    const fullFilePath = path.join(folderPath, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      response = response.concat(getAllFiles(fullFilePath));
    } else if (entry.isFile()) {
      response.push(fullFilePath);
    }
  }

  return response;
};

function readPackageJson(dir: string): any | null {
  try {
    const raw = fs
      .readFileSync(path.join(dir, "package.json"), "utf8")
      // Windows editors/scripts sometimes save a UTF-8 BOM, which JSON.parse
      // rejects with an unhelpful error.
      .replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function hasBuildScript(dir: string): boolean {
  const pkg = readPackageJson(dir);
  return typeof pkg?.scripts?.build === "string";
}

function collectPackageRoots(root: string, maxDepth: number): string[] {
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const skip = new Set([
    ...SKIP_DIRS,
    "dist",
    "build",
    "out",
    ".next",
    "coverage",
  ]);

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;

    if (fs.existsSync(path.join(dir, "package.json"))) {
      results.push(dir);
    }

    if (depth >= maxDepth) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !skip.has(entry.name) &&
        !entry.name.startsWith(".")
      ) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }

  return results;
}

/**
 * Finds the folder that actually contains the app's package.json.
 * Handles repos where the app lives in a subfolder (e.g. monorepos).
 */
export function findProjectRoot(jobDir: string): string {
  const candidates = collectPackageRoots(jobDir, 2);

  if (candidates.length === 0) {
    throw new Error(
      `No package.json found in ${jobDir} (or up to 2 levels deep). ` +
        `This repo does not look like a Node project.`
    );
  }

  const buildable = candidates.filter(hasBuildScript);

  if (buildable.length === 1) return buildable[0];

  if (buildable.length > 1) {
    const root = buildable.find((dir) => dir === jobDir);
    if (root) return root;

    throw new Error(
      `Multiple projects with a "build" script were found: ` +
        `${buildable.map((dir) => path.relative(jobDir, dir)).join(", ")}. ` +
        `Set BUILD_OUTPUT_DIR or restructure the repo so only one app exists.`
    );
  }

  // Nothing has a build script: return a root so the error below is explicit.
  const root = candidates.find((dir) => dir === jobDir);
  if (root) return root;

  if (candidates.length === 1) return candidates[0];

  throw new Error(
    `Could not decide which project to build. Found package.json in: ` +
      `${candidates.map((dir) => path.relative(jobDir, dir)).join(", ")}.`
  );
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;

  if (process.platform === "win32") {
    // npm spawns node processes; plain kill() leaves them running on Windows.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onLog: Logger,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    onLog(`$ ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      cwd,
      // shell:true is required on Windows to run npm.cmd / && style commands.
      shell: true,
      env: { ...process.env, ...extraEnv },
      windowsHide: true,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, BUILD_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim() !== "") onLog(line);
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(
          new Error(
            `Command timed out after ${Math.round(
              BUILD_TIMEOUT_MS / 1000
            )}s: ${command} ${args.join(" ")}`
          )
        );
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `Command failed with exit code ${code}: ${command} ${args.join(" ")}`
        )
      );
    });
  });
}

export async function installDependencies(
  projectRoot: string,
  onLog: Logger
): Promise<void> {
  await runCommand(
    "npm",
    ["install", "--no-audit", "--no-fund", "--no-progress", "--include=dev"],
    projectRoot,
    onLog,
    {
      // Some hosts start the service with NODE_ENV=production, which makes npm
      // skip devDependencies (vite, react-scripts, typescript...). Force them.
      NODE_ENV: "development",
      CI: "true",
    }
  );
}

export async function buildProject(
  projectRoot: string,
  onLog: Logger
): Promise<void> {
  const pkg = readPackageJson(projectRoot);

  if (typeof pkg?.scripts?.build !== "string") {
    throw new Error(
      `package.json in ${projectRoot} has no "build" script. ` +
        `Available scripts: ${
          pkg?.scripts ? Object.keys(pkg.scripts).join(", ") : "none"
        }`
    );
  }

  await runCommand("npm", ["run", "build"], projectRoot, onLog, {
    // CRA turns warnings into errors when CI=true; keep builds tolerant.
    CI: "false",
  });
}

const DEFAULT_OUTPUT_DIRS = ["dist", "build", "out"];

/**
 * Finds the static output folder produced by the build.
 * dist/build -> Vite, CRA, Angular; out -> Next.js `output: "export"`.
 */
export function findBuildOutput(projectRoot: string): string {
  const override = process.env.BUILD_OUTPUT_DIR;
  const names = override ? [override] : DEFAULT_OUTPUT_DIRS;

  const existing = names
    .map((name) => path.resolve(projectRoot, name))
    .filter((dir) => {
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    });

  const withIndex = existing.find((dir) =>
    fs.existsSync(path.join(dir, "index.html"))
  );
  if (withIndex) return withIndex;
  if (existing.length > 0) return existing[0];

  const nextDir = path.join(projectRoot, ".next");
  if (fs.existsSync(nextDir)) {
    throw new Error(
      `Only .next/ was produced. This deploy target serves static files, so ` +
        `Next.js needs "output: 'export'" in next.config.js (which emits out/).`
    );
  }

  let topLevel = "";
  try {
    topLevel = fs
      .readdirSync(projectRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .join(", ");
  } catch {
    topLevel = "(unreadable)";
  }

  throw new Error(
    `Build finished but no static output folder was found. Looked for: ` +
      `${names.join(", ")} in ${projectRoot}. Top-level folders: ${topLevel}. ` +
      `If your framework uses another folder, set BUILD_OUTPUT_DIR.`
  );
}
