// First: zod's config has to be in place before any schema is built (see the file).
import "../lib/zod-config.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import "./gallery.css";
import { GalleryPage } from "./GalleryPage.tsx";
import { GALLERY_SECTIONS } from "./sections.ts";

/** The gallery of view states (`gallery.html`), a page of its own beside the app; see `GalleryPage`. */
const root = document.getElementById("root");
if (!root) throw new Error("missing #root in gallery.html");
createRoot(root).render(
  <StrictMode>
    <GalleryPage sections={GALLERY_SECTIONS} />
  </StrictMode>,
);
