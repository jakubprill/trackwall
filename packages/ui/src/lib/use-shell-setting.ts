import { useState } from "react";
import { errorMessage } from "./api.ts";
import { currentRun } from "./background-run.ts";
import { type RemoteHandle, useRemote } from "./use-remote.ts";

/**
 * A setting the desktop shell keeps (start at sign-in, keeping the screen on): read with `read`, changed with `write`,
 * which answers what the shell has afterwards. That answer shows until a read sent after it lands, so the control does
 * not jump back, and the setting is read again after every change, also after a refusal, whose message is `error`.
 * `read` must be stable between renders.
 */
export function useShellSetting<T>(
  read: () => Promise<T>,
  write: (wanted: T) => Promise<T>,
): {
  remote: RemoteHandle<T>;
  value: T | null | undefined;
  busy: boolean;
  error: string | undefined;
  change: (wanted: T) => Promise<void>;
} {
  const remote = useRemote(read);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [answer, setAnswer] = useState<{ run: T; afterLoad: number }>();

  async function change(wanted: T) {
    setBusy(true);
    setError(undefined);
    try {
      setAnswer({ run: await write(wanted), afterLoad: remote.sentLoads() });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      remote.reload();
      setBusy(false);
    }
  }

  return { remote, value: currentRun(answer, remote), busy, error, change };
}
