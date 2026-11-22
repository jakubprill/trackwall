import type { Session } from "@trackwall/protocol";
import { sessionKey } from "@trackwall/scene/model";
import { homeModel } from "@/lib/home-model";
import { HomeDetails } from "@/views/home/HomeDetails";
import type { GalleryState } from "./gallery-state.ts";
import { LONG_REPO, MVNW_APPROVAL, NO_DAEMON, sampleId, stateOf, waiting } from "./sample-data.ts";
import { NewComputerTips } from "./tips-states.tsx";

/** Home's details column with `session` picked, as high as its content. */
function DetailsOf({ session }: { session: Session }) {
  const model = homeModel({ repos: [], sessions: [session], graph: undefined, running: [], services: [], daemonRunning: true });
  return (
    <HomeDetails
      conn={NO_DAEMON}
      loading={false}
      selected={sessionKey(session.id)}
      model={model}
      repos={new Map()}
      sessions={new Map([[session.id, session]])}
      running={[]}
      onSelect={() => {}}
      onOpen={() => {}}
    />
  );
}

/** A task's approval with Trackwall's "Always allow" (ADR-249) and its tip, as a new computer shows it the first time (ADR-296). */
const alwaysAllowWithTip: GalleryState = {
  name: "A task's approval with Always allow and its tip",
  render: () => (
    <NewComputerTips>
      <DetailsOf session={waiting(1, 3, { repo: LONG_REPO, task: sampleId(2), state: stateOf("Approval"), dialog: MVNW_APPROVAL })} />
    </NewComputerTips>
  ),
};

export const HOME_DETAILS_STATES: readonly GalleryState[] = [alwaysAllowWithTip];
