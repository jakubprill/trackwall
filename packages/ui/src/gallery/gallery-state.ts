import type { ReactNode } from "react";

/** One state of a part of a view in the gallery: its name and the part rendered with sample data in that state. */
export interface GalleryState {
  name: string;
  render: () => ReactNode;
}

/** A size the part has in the app, as Tailwind classes for the frame, and its name in the frame's caption. */
interface GallerySize {
  name: string;
  className: string;
}

/**
 * A part of a view with all its states, at each size it has in the app: the gallery draws every state at each size, in
 * each theme, with the test browser's font and with a wider one, side by side.
 */
export interface GallerySection {
  /** The view and the part, as the user knows them: "Sessions · the list". */
  name: string;
  sizes: readonly [GallerySize, ...GallerySize[]];
  states: readonly GalleryState[];
}
