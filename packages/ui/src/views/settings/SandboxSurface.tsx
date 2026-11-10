import { agentsApi, type SandboxState, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { SANDBOX_CHOICES, type SandboxChoice, sandboxChoice, sandboxNow, sandboxSettingsOf } from "@/lib/sandbox";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { SavedAs } from "./SavedAs.tsx";

/**
 * Copilot CLI's sandbox for tasks (ADR-181), chosen here instead of by hand in `workspace.yaml` (ADR-239): which tasks
 * run their commands in it, and below the choice what the next task gets on this computer, from the daemon, which alone
 * knows the default here and whether the sandbox can run.
 */
export function SandboxSurface({ conn }: { conn: Connection }) {
  const loadSettings = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(loadSettings);
  const loadOptions = useCallback(() => post(conn, agentsApi.startOptions, {}), [conn]);
  const options = useRemote(loadOptions);
  const save = useAction(
    (choice: SandboxChoice) => post(conn, workspaceApi.setSandbox, { sandbox: sandboxSettingsOf(choice) }),
    () => {
      settings.reload();
      options.reload();
    },
  );

  const data = settings.data;
  // With a key written wrong no choice is ticked: the problem says why, and any choice fixes it.
  const chosen = data && data.sandboxProblem === null ? sandboxChoice(data.sandbox) : undefined;
  return (
    <Surface label="Sandbox">
      <div className="flex flex-col gap-3 p-4">
        <p className="text-muted-foreground text-sm">
          A task in Copilot CLI's sandbox runs each shell command under your system's isolation: it can write only in the task's worktree
          and cannot read your other repos or folders such as ~/.ssh. Choose which tasks run in it. The choice applies to the tasks you
          start after it; a running task keeps the sandbox it started with.
        </p>
        {settings.error && <ErrorWithRetry message={settings.error} onRetry={settings.reload} />}
        {!data && !settings.error && <Loading />}
        {data && (
          <div role="radiogroup" aria-label="Tasks in the sandbox" className="flex flex-col gap-2">
            {SANDBOX_CHOICES.map(({ choice, label }) => (
              <label key={choice} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="sandbox-tasks"
                  className="accent-primary size-4 shrink-0"
                  checked={chosen === choice}
                  disabled={save.pending}
                  onChange={() => save.run(choice)}
                />
                {label}
              </label>
            ))}
          </div>
        )}
        {data?.sandboxProblem && <p className="text-destructive text-xs break-words">{data.sandboxProblem}</p>}
        {options.data && <SandboxNow state={options.data.sandbox} />}
        {save.error && <p className="text-destructive text-xs break-words">{save.error}</p>}
        {data && <SavedAs configKey="sandbox" configFile={data.configFile} />}
      </div>
    </Surface>
  );
}

function SandboxNow({ state }: { state: SandboxState }) {
  const now = sandboxNow(state);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <p className="text-muted-foreground">{now.text}</p>
      {now.problem && (
        <p className={`break-words ${now.problem.refused ? "text-destructive" : "text-muted-foreground"}`}>{now.problem.text}</p>
      )}
    </div>
  );
}
