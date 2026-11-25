import path from "path";
import dotenv from "dotenv";

// Loads <service>/.env whether this file is executed from src/ (tsx) or dist/ (tsc).
dotenv.config({ path: path.join(__dirname, "..", ".env"), quiet: true });

export const WORK_DIR =
  process.env.WORK_DIR ?? path.join(__dirname, "..", "output");

/**
 * Accepts both `redis://host:port` and bare `host:port` (a common .env
 * mistake). Without this, node-redis throws ERR_INVALID_URL at startup.
 */
function normalizeRedisUrl(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") return "redis://127.0.0.1:6379";
  if (/^(redis|rediss):\/\//i.test(raw)) return raw;
  return `redis://${raw}`;
}

export const REDIS_URL = normalizeRedisUrl(process.env.REDIS_URL);

export const BUCKET_NAME =
  process.env.AWS_BUCKET_NAME ?? "vercel-bucket-test62";

export const PORT = Number(process.env.PORT ?? 3000);

export const REQUEST_HANDLER_BASE_URL =
  process.env.REQUEST_HANDLER_BASE_URL ?? "http://localhost:4000";
