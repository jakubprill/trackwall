import type { WorkspaceSettings } from "@trackwall/protocol";
import type { Connection } from "@/lib/connection";
import { useProviderModels } from "@/lib/use-provider-models";
import type { RemoteHandle } from "@/lib/use-remote";
import { PathForm } from "./PathForm.tsx";
import { SettingsRead } from "./SettingsRead.tsx";

/** A Copilot CLI model kept in `workspace.yaml`: its value and why the file's value cannot be read. */
interface ModelSetting {
  model: string | null;
  problem: string | null;
}

/**
 * One model setting of Settings › Agents, such as the supervisor's model (ADR-193) or the retry model (ADR-233): a
 * field that suggests the provider's models, saves the id to its key in `workspace.yaml` and removes the key on reset.
 */
export function ModelSettingSurface({
  conn,
  settings,
  label,
  description,
  placeholder,
  configKey,
  resetLabel,
  read,
  save,
}: {
  conn: Connection;
  settings: RemoteHandle<WorkspaceSettings>;
  label: string;
  description: string;
  placeholder: string;
  configKey: string;
  resetLabel: string;
  read: (settings: WorkspaceSettings) => ModelSetting;
  /** Saves the model, `null` removing the key. */
  save: (model: string | null) => Promise<unknown>;
}) {
  const { models } = useProviderModels(conn);

  async function saveAndReload(model: string | null) {
    await save(model);
    settings.reload();
  }

  const data = settings.data;
  const setting = data ? read(data) : null;
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-muted-foreground text-sm">{description}</p>
      <SettingsRead settings={settings} />
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
  );
}
