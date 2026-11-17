import type { GallerySection } from "./gallery-state.ts";
import { GET_STARTED_STATES } from "./get-started-states.tsx";
import { HOME_STATES } from "./home-states.tsx";
import { SESSION_LIST_STATES } from "./session-list-states.tsx";
import { TRAY_PANEL_STATES } from "./tray-panel-states.tsx";

/** The parts of views the gallery shows, in the order of the page, each at the sizes it takes in the app. */
export const GALLERY_SECTIONS: readonly GallerySection[] = [
  { name: "Sessions · the list", sizes: [{ name: "fixed width", className: "w-sidebar" }], states: SESSION_LIST_STATES },
  {
    name: "Home · Needs you",
    // The column shrinks from the sidebar width down to 12rem in a narrow window.
    sizes: [
      { name: "widest", className: "w-sidebar" },
      { name: "narrowest", className: "w-48" },
    ],
    states: HOME_STATES,
  },
  // The size of the panel's window (`PANEL` in apps/desktop/src-tauri/src/tray_panel.rs).
  { name: "Tray panel", sizes: [{ name: "its window", className: "h-[420px] w-[340px]" }], states: TRAY_PANEL_STATES },
  {
    name: "Settings · Get started",
    // The column of a category in a wide window, and what is left of it in the narrowest one with the supervisor panel pinned.
    sizes: [
      { name: "widest", className: "w-xl" },
      { name: "narrowest", className: "w-80" },
    ],
    states: GET_STARTED_STATES,
  },
];
