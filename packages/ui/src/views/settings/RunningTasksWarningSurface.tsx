import { agentsApi, type WorkspaceSettings, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { computerDefaultLabel, parseRunningTasksWarning } from "@/lib/running-tasks-warning";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { PathForm } from "./PathForm.tsx";
import { SettingsRead } from "./SettingsRead.tsx";

const LABEL = "Warn above running tasks";

/**
 * The running tasks warning (ADR-248): above how many running tasks starting another one warns that the computer may
 * slow down, saved as `runningTasksWarning` in `workspace.yaml`; without it, the default the daemon picks from the
 * processors and memory of the computer or container it runs on.
 */
export function RunningTasksWarningSurface({ conn, settings }: { conn: Connection; settings: RemoteHandle<WorkspaceSettings> }) {
  const loadOptions = useCallback(() => post(conn, agentsApi.startOptions, {}), [conn]);
  const options = useRemote(loadOptions);

  async function save(above: number | null) {
    await post(conn, workspaceApi.setRunningTasksWarning, { above });
    settings.reload();
  }

  async function saveTyped(text: string) {
    const parsed = parseRunningTasksWarning(text);
    if ("problem" in parsed) throw new Error(parsed.problem);
    await save(parsed.above);
  }

  const data = settings.data;
  const warning = options.data?.runningTasksWarning;
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-muted-foreground text-sm">
        Every running task holds Copilot CLI and the builds, tests and services it runs, on this computer and next to your editor. When
        starting a task would make more of them run at once than this number, the New session form and the task proposals say so before you
        start. It only warns: you can still start.
        {warning && <> Without a number of your own, the default is {computerDefaultLabel(warning)}.</>}
      </p>
      <SettingsRead settings={settings} />
      {data && (
        <PathForm
          key={data.runningTasksWarning ?? ""}
          label={LABEL}
          placeholder={warning ? String(warning.computerDefault) : "4"}
          configKey="runningTasksWarning"
          initialPath={data.runningTasksWarning === null ? "" : String(data.runningTasksWarning)}
          configFile={data.configFile}
          folder={false}
          save={saveTyped}
          resetLabel="Computer's default"
          reset={data.runningTasksWarning === null && !data.runningTasksWarningProblem ? undefined : () => save(null)}
        />
      )}
      {data?.runningTasksWarningProblem && <p className="text-destructive text-xs break-words">{data.runningTasksWarningProblem}</p>}
    </div>
  );
}
