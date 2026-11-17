import type { WorkspaceSettings } from "@trackwall/protocol";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import type { RemoteHandle } from "@/lib/use-remote";

/**
 * What a setting's form shows while the one read of the workspace settings it shares with the other rows (ADR-263) has
 * no data: the error with a retry, or that it is loading.
 */
export function SettingsRead({ settings }: { settings: RemoteHandle<WorkspaceSettings> }) {
  if (settings.error) return <ErrorWithRetry message={settings.error} onRetry={settings.reload} />;
  return settings.data ? null : <Loading />;
}
