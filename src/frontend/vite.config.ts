import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" },
  // The backend serves the fire data; in development the dashboard reaches it through this proxy.
  server: { proxy: { "/api": process.env.API_PROXY ?? "http://localhost:8000" } },
});
