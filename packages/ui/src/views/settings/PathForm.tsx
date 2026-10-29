import { isTauri } from "@tauri-apps/api/core";
import { FolderOpen } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { useDesktop } from "@/lib/desktop";
import { pickFolder } from "@/lib/folder-picker";

/**
 * A path setting saved as one key of `workspace.yaml`: the projects folder (ADR-18), the task worktrees folder (ADR-84) or
 * the git program (ADR-112).
 */
export function PathForm({
  label,
  placeholder,
  configKey,
  initialPath,
  configFile,
  save,
  reset,
  folder = true,
}: {
  label: string;
  placeholder: string;
  configKey: string;
  initialPath: string;
  /** Unknown when `workspace.yaml` failed validation. */
  configFile?: string;
  save: (path: string) => Promise<void>;
  /** Back to the default; without it the setting has no default to go back to, or already uses it. */
  reset?: () => Promise<void>;
  /** A folder gets the system folder picker, unless the daemon has no desktop here (ADR-130); a program is typed or pasted. */
  folder?: boolean;
}) {
  const desktop = useDesktop();
  const [path, setPath] = useState(initialPath);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(() => save(path.trim()));
  }

  /** Only the Tauri window has the system picker (ADR-51). A folder chosen in it is saved at once: choosing it already says what the user wants. */
  async function browse() {
    setError(undefined);
    let picked: string | undefined;
    try {
      picked = await pickFolder(path.trim());
    } catch (err) {
      return setError(errorMessage(err));
    }
    if (picked === undefined) return;
    setPath(picked);
    await run(() => save(picked));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          className="font-mono text-xs"
        />
        {folder && isTauri() && desktop && (
          <Button type="button" variant="outline" size="sm" onClick={() => void browse()} disabled={busy}>
            <FolderOpen /> Choose…
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy || path.trim() === ""}>
          Save
        </Button>
        {reset && (
          <Button type="button" variant="ghost" size="sm" onClick={() => void run(reset)} disabled={busy}>
            Use default
          </Button>
        )}
      </div>
      {error && <p className="text-destructive text-xs break-words">{error}</p>}
      <p className="text-muted-foreground text-xs break-all">
        {configFile ? (
          <>
            Saved as <span className="font-mono">{configKey}</span> in <span className="font-mono">{configFile}</span>
          </>
        ) : (
          `Fix the YAML syntax error in the file named above; saving here only fixes a bad ${configKey}.`
        )}
      </p>
    </form>
  );
}
