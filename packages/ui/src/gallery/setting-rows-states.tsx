import type { ReactNode } from "react";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SETTING_ROWS, type SettingRowId, type SettingValue } from "@/lib/setting-rows";
import { SettingRow } from "@/views/settings/SettingRow";
import type { GalleryState } from "./gallery-state.ts";

type RowSample = { row: SettingRowId; value: SettingValue | null; form?: ReactNode };

/** A group of folded rows as Settings draws it; a row with a `form` stands open. */
function Group({ label, rows }: { label: string; rows: RowSample[] }) {
  return (
    <Surface label={label}>
      {rows.map(({ row, value, form }) => (
        <SettingRow key={row} {...SETTING_ROWS[row]} value={value} open={form !== undefined} onToggle={() => {}}>
          {form}
        </SettingRow>
      ))}
    </Surface>
  );
}

const fallback = (text: string): SettingValue => ({ text, state: "default" });
const changed = (text: string): SettingValue => ({ text, state: "changed" });

const LONG_FOLDER = "C:\\Users\\alexandra.featherstonehaugh\\source\\repos\\customer-notification-preferences";

const defaults: GalleryState = {
  name: "Nothing changed, every row folded",
  render: () => (
    <Group
      label="Tasks"
      rows={[
        { row: "sandbox", value: fallback("default for this computer") },
        { row: "auto-review", value: fallback("off") },
        { row: "always-allow", value: fallback("none") },
        { row: "task-token-budget", value: fallback("no budget") },
        { row: "running-tasks-warning", value: fallback("computer's default") },
        { row: "retry-model", value: fallback("none") },
        { row: "java-navigation", value: null },
      ]}
    />
  ),
};

const changedValues: GalleryState = {
  name: "Changed values, some long",
  render: () => (
    <div className="flex flex-col gap-4">
      <Group
        label="Folders"
        rows={[
          { row: "projects-folder", value: fallback(LONG_FOLDER) },
          { row: "worktrees-dir", value: changed(`${LONG_FOLDER}\\.trackwall\\worktrees-on-the-fast-disk`) },
          { row: "git-program", value: changed("C:\\Users\\alexandra.featherstonehaugh\\Dev\\tools\\mingit\\cmd\\git.exe") },
        ]}
      />
      <Group
        label="Supervisor"
        rows={[
          { row: "supervisor-model", value: changed("provider-of-my-own/claude-opus-5.5-with-a-long-deployment-name") },
          { row: "supervisor-changes-code", value: changed("on") },
        ]}
      />
    </div>
  ),
};

const openWithProblem: GalleryState = {
  name: "A problem opens its row",
  render: () => (
    <Group
      label="Folders"
      rows={[
        {
          row: "projects-folder",
          value: { text: "not set", state: "problem" },
          form: (
            <div className="flex flex-col gap-4 p-4">
              <p className="text-muted-foreground text-sm">
                The Repos view shows every git repo directly inside this folder. A repo cloned into it appears in the list on its own.
              </p>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value=""
                  placeholder="/home/me/dev"
                  aria-label="Full path to the projects folder"
                  className="font-mono text-xs"
                />
                <Button size="sm" disabled>
                  Save
                </Button>
              </div>
            </div>
          ),
        },
        { row: "worktrees-dir", value: fallback("default") },
        { row: "git-program", value: { text: "cannot be read", state: "problem" } },
      ]}
    />
  ),
};

export const SETTING_ROWS_STATES: readonly GalleryState[] = [defaults, changedValues, openWithProblem];
