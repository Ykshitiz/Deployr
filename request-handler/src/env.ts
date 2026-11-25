import path from "path";
import dotenv from "dotenv";

// Loads <service>/.env whether this file is executed from src/ (tsx) or dist/ (tsc).
dotenv.config({ path: path.join(__dirname, "..", ".env"), quiet: true });

export const BUCKET_NAME =
  process.env.AWS_BUCKET_NAME ?? "vercel-bucket-test62";

export const PORT = Number(process.env.PORT ?? 3001);
