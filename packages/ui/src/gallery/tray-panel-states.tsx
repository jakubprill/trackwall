import type { SessionList } from "@trackwall/protocol";
import { TrayPanelContent } from "@/views/tray-panel/TrayPanel";
import type { GalleryState } from "./gallery-state.ts";
import { LONG_REPO, LONG_TITLE, MVNW_APPROVAL, NO_DAEMON, proposal, sessionList, stateOf, waiting } from "./sample-data.ts";

/** The tray panel at its window's size for `list`, or before it arrives, or with a failure. */
function TrayPanelOf({ list, failure }: { list?: SessionList; failure?: string }) {
  return <TrayPanelContent conn={NO_DAEMON} list={list} failure={failure} onOpen={() => {}} className="h-full" />;
}

const busy: GalleryState = {
  name: "Approvals, proposals and waiting sessions",
  render: () => (
    <TrayPanelOf
      list={sessionList({
        sessions: [
          waiting(1, 135, { repo: LONG_REPO, state: stateOf("Approval"), dialog: MVNW_APPROVAL }),
          waiting(2, 4, {
            state: stateOf("Input"),
            windowTitle: LONG_TITLE,
            dialog: { id: "q", kind: "question", question: "Which of the two discount rules should win when both apply?" },
          }),
          waiting(3, 1, { repo: "orders-api", state: stateOf("Plan", "medium") }),
        ],
        proposals: [proposal(10, 1, { title: LONG_TITLE })],
      })}
    />
  ),
};

const quiet: GalleryState = { name: "Nothing waits", render: () => <TrayPanelOf list={sessionList({})} /> };
const connecting: GalleryState = { name: "Connecting", render: () => <TrayPanelOf /> };
const failed: GalleryState = {
  name: "The daemon is not running",
  render: () => <TrayPanelOf failure="The daemon is not running. Open Trackwall to start it again." />,
};

export const TRAY_PANEL_STATES: readonly GalleryState[] = [busy, quiet, connecting, failed];
