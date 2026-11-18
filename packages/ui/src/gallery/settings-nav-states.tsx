import type { SettingsCategory } from "@/lib/settings-categories";
import { SettingsNav } from "@/views/settings/SettingsNav";
import type { GalleryState } from "./gallery-state.ts";

/**
 * The list of Settings categories in a view as wide as its frame: a column with captions in the wide one, one row of
 * entries that scrolls sideways in the narrow one.
 */
function Nav({ current, openSteps }: { current: SettingsCategory; openSteps: number | null }) {
  return (
    <div className="@container w-full">
      <SettingsNav current={current} openSteps={openSteps} onSelect={() => {}} />
    </div>
  );
}

export const SETTINGS_NAV_STATES: readonly GalleryState[] = [
  { name: "Get started shown, steps to do", render: () => <Nav current="get-started" openSteps={2} /> },
  { name: "Another category shown, one step to do", render: () => <Nav current="workspace" openSteps={1} /> },
  { name: "All set, a report shown", render: () => <Nav current="diagnostics" openSteps={0} /> },
  { name: "The doctor never ran", render: () => <Nav current="agents" openSteps={null} /> },
];
