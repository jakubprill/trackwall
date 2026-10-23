import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { daemonDevProxy } from "./dev-proxy.ts";

export default defineConfig({
  plugins: [react(), tailwindcss(), daemonDevProxy()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Ścieżki od korzenia: daemon serwuje index.html także dla zagnieżdżonych tras (np. /tasks/123),
  // a Tauri udostępnia frontendDist pod korzeniem własnego protokołu.
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
