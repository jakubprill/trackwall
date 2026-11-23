/** Where a setting is saved: its key in `workspace.yaml`, so the user can find it to edit by hand. */
export function SavedAs({ configKey, configFile }: { configKey: string; configFile: string }) {
  return (
    <p className="text-muted-foreground text-xs break-all">
      Saved as <span className="font-mono">{configKey}</span> in <span className="font-mono">{configFile}</span>
    </p>
  );
}
