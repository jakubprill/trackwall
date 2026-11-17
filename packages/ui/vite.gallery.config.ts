import { defineConfig, mergeConfig } from "vite";
import app from "./vite.config.ts";

/**
 * The gallery of view states (`gallery.html`, `src/gallery`) on its own: the same plugins and aliases as the app, built
 * into `dist-gallery` with relative paths, so that it opens from any folder (GitHub Pages, a test) and never ships with
 * the app. `vite dev` of the app serves it too, at /gallery.html.
 */
export default mergeConfig(
  app,
  defineConfig({
    base: "./",
    build: {
      outDir: "dist-gallery",
      rolldownOptions: { input: "gallery.html" },
    },
  }),
);
