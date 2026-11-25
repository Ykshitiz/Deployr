import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/deploy": { target: API, changeOrigin: true },
      "/deployments": { target: API, changeOrigin: true },
      "/status": { target: API, changeOrigin: true },
      "/logs": { target: API, changeOrigin: true },
      "/health": { target: API, changeOrigin: true },
    },
  },
});
