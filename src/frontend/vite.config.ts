import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/** Sends `/dashboard` to `/dashboard/` in the dev server, as the API does in production. */
function dashboardSlash(): Plugin {
  return {
    name: "dashboard-slash",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const [path, query] = (req.url ?? "").split("?");
        if (path !== "/dashboard") return next();
        res.statusCode = 307;
        res.setHeader("Location", `/dashboard/${query ? `?${query}` : ""}`);
        res.end();
      });
    },
  };
}

// Two pages: the landing page at / and the dashboard at /dashboard/.
export default defineConfig({
  appType: "mpa",
  plugins: [dashboardSlash()],
  worker: { format: "es" },
  build: {
    rolldownOptions: {
      input: { landing: resolve(__dirname, "index.html"), dashboard: resolve(__dirname, "dashboard/index.html") },
    },
  },
  // The backend serves the fire data; in development the dashboard reaches it through this proxy.
  server: { proxy: { "/api": process.env.API_PROXY ?? "http://localhost:8000" } },
});
