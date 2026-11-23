import { WhatsNewStrip } from "@/components/WhatsNew";
import { WHATS_NEW, WHATS_NEW_MOST, type WhatsNewEntry } from "@/lib/whats-new";
import type { GalleryState } from "./gallery-state.ts";
import { LONG_REPO, NO_DAEMON } from "./sample-data.ts";

const nothing = () => {};

/** Two made-up entries, one with a long name and one with no place to show, which the real ones fill up to the most the list holds. */
const MORE: readonly WhatsNewEntry[] = [
  {
    id: "sample-long-name",
    title: `Every repo's service in one table, with ${LONG_REPO} first`,
    text: "A sample entry with a name longer than any real one, so that the strip shows how it wraps.",
    show: { place: { kind: "view", view: "repos" } },
  },
  { id: "sample-no-place", title: "Faster start", text: "A change with no place of its own to show, so it has no Show." },
];

const thisVersion: GalleryState = {
  name: "The changes of this version",
  render: () => <WhatsNewStrip conn={NO_DAEMON} entries={WHATS_NEW} onShow={nothing} onDismiss={nothing} />,
};

const oneLeft: GalleryState = {
  name: "One change a computer has not seen",
  render: () => <WhatsNewStrip conn={NO_DAEMON} entries={WHATS_NEW.slice(0, 1)} onShow={nothing} onDismiss={nothing} />,
};

const most: GalleryState = {
  name: "As many changes as it lists",
  render: () => (
    <WhatsNewStrip conn={NO_DAEMON} entries={[...MORE, ...WHATS_NEW].slice(0, WHATS_NEW_MOST)} onShow={nothing} onDismiss={nothing} />
  ),
};

export const WHATS_NEW_STATES: readonly GalleryState[] = [thisVersion, oneLeft, most];
