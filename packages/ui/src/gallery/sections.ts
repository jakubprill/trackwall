import { ALL_REPOS_STATES } from "./all-repos-states.tsx";
import type { GallerySection } from "./gallery-state.ts";
import { GET_STARTED_CARD_STATES, GET_STARTED_STATES } from "./get-started-states.tsx";
import { HOME_DETAILS_STATES } from "./home-details-states.tsx";
import { HOME_STATES } from "./home-states.tsx";
import { SESSION_LIST_STATES } from "./session-list-states.tsx";
import { SETTING_ROWS_STATES } from "./setting-rows-states.tsx";
import { SETTINGS_NAV_STATES } from "./settings-nav-states.tsx";
import { TIP_STATES } from "./tips-states.tsx";
import { TRAY_PANEL_STATES } from "./tray-panel-states.tsx";
import { WHATS_NEW_STATES } from "./whats-new-states.tsx";

/** The parts of views the gallery shows, in the order of the page, each at the sizes it takes in the app. */
export const GALLERY_SECTIONS: readonly GallerySection[] = [
  { name: "Sessions · the list", sizes: [{ name: "fixed width", className: "w-sidebar" }], states: SESSION_LIST_STATES },
  {
    name: "Tips",
    // A tip is as wide as its place: the Sessions list, and a task's panel or the New session form. The narrowest, an
    // approval in Home's details, is drawn in its place in "Home · the details".
    sizes: [
      { name: "the Sessions list", className: "w-sidebar" },
      { name: "a view", className: "w-3xl" },
    ],
    states: TIP_STATES,
  },
  {
    name: "What's new",
    // Above the views, beside the view bar and the folded supervisor panel: a wide window, and the smallest the desktop app opens.
    sizes: [
      { name: "wide window", className: "w-6xl" },
      { name: "smallest window", className: "w-xl" },
    ],
    states: WHATS_NEW_STATES,
  },
  {
    name: "Sessions · Get started above the form",
    // The card's widest, and the view next to the list and a pinned supervisor panel in a 1024 px window.
    sizes: [
      { name: "widest", className: "w-3xl" },
      { name: "narrowest", className: "w-80" },
    ],
    states: GET_STARTED_CARD_STATES,
  },
  {
    name: "Home · Needs you",
    // The column shrinks from the sidebar width down to 12rem in a narrow window, and is as high as the window: 650 px on
    // the small screen of the E2E tests (`SMALL_SCREEN`), which the longest states overfill.
    sizes: [
      { name: "widest", className: "h-[650px] w-sidebar" },
      { name: "narrowest", className: "h-[650px] w-48" },
    ],
    states: HOME_STATES,
  },
  {
    name: "Home · the details",
    // The column beside the scene, as wide as the "Needs you" column on the other side: from the sidebar width down to 12rem.
    sizes: [
      { name: "widest", className: "w-sidebar" },
      { name: "narrowest", className: "w-48" },
    ],
    states: HOME_DETAILS_STATES,
  },
  {
    name: "Repos · All repos",
    // The panel beside the repo list in a wide window, and what is left of it beside the pinned supervisor panel.
    sizes: [
      { name: "wide", className: "w-5xl" },
      { name: "narrowest", className: "w-80" },
    ],
    states: ALL_REPOS_STATES,
  },
  // The size of the panel's window (`PANEL` in apps/desktop/src-tauri/src/tray_panel.rs).
  { name: "Tray panel", sizes: [{ name: "its window", className: "h-[420px] w-[340px]" }], states: TRAY_PANEL_STATES },
  {
    name: "Settings · the list of categories",
    // The Settings view in a wide window, where the list is a column, and in the narrowest one, where it is a row.
    sizes: [
      { name: "wide view", className: "w-4xl" },
      { name: "narrow view", className: "w-80" },
    ],
    states: SETTINGS_NAV_STATES,
  },
  {
    name: "Settings · Get started",
    // The column of a category in a wide window, and what is left of it in the narrowest one with the supervisor panel pinned.
    sizes: [
      { name: "widest", className: "w-xl" },
      { name: "narrowest", className: "w-80" },
    ],
    states: GET_STARTED_STATES,
  },
  {
    name: "Settings · a group of settings",
    // The same column as "Get started".
    sizes: [
      { name: "widest", className: "w-xl" },
      { name: "narrowest", className: "w-80" },
    ],
    states: SETTING_ROWS_STATES,
  },
];
