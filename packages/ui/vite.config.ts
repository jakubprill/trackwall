import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { daemonDevProxy } from "./dev-proxy.ts";
import { dropUnreferencedDraco } from "./drop-unreferenced-draco.ts";

export default defineConfig({
  plugins: [react(), tailwindcss(), daemonDevProxy(), dropUnreferencedDraco()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Paths from the root: the daemon serves index.html for nested routes too (e.g. /tasks/123),
  // and Tauri serves frontendDist at the root of its own protocol.
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: ["es2022", "chrome110", "safari16"],
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
  },
  clearScreen: false,
});
