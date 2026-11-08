import { type WorkspaceSettings, workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useProviderModels } from "@/lib/use-provider-models";
import { useRemote } from "@/lib/use-remote";
import { PathForm } from "./PathForm.tsx";

/** A Copilot CLI model kept in `workspace.yaml`: its value and why the file's value cannot be read. */
interface ModelSetting {
  model: string | null;
  problem: string | null;
}

/**
 * One model setting of Settings › Agents, such as the supervisor's model (ADR-193) or the retry model (ADR-232): a
 * field that suggests the provider's models, saves the id to its key in `workspace.yaml` and removes the key on reset.
 */
export function ModelSettingSurface({
  conn,
  label,
  description,
  placeholder,
  configKey,
  resetLabel,
  read,
  save,
}: {
  conn: Connection;
  label: string;
  description: string;
  placeholder: string;
  configKey: string;
  resetLabel: string;
  read: (settings: WorkspaceSettings) => ModelSetting;
  /** Saves the model, `null` removing the key. */
  save: (model: string | null) => Promise<unknown>;
}) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);
  const { models } = useProviderModels(conn);

  async function saveAndReload(model: string | null) {
    await save(model);
    settings.reload();
  }

  const data = settings.data;
  const setting = data ? read(data) : null;
  return (
    <Surface label={label}>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">{description}</p>
        {settings.error && <ErrorWithRetry message={settings.error} onRetry={settings.reload} />}
        {!data && !settings.error && <Loading />}
        {data && setting && (
          <PathForm
            key={setting.model ?? ""}
            label={label}
            placeholder={placeholder}
            configKey={configKey}
            initialPath={setting.model ?? ""}
            configFile={data.configFile}
            folder={false}
            suggestions={models}
            save={saveAndReload}
            resetLabel={resetLabel}
            reset={setting.model === null && !setting.problem ? undefined : () => saveAndReload(null)}
          />
        )}
        {setting?.problem && <p className="text-destructive text-xs break-words">{setting.problem}</p>}
      </div>
    </Surface>
  );
}
