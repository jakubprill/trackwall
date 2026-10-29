import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

/**
 * A remote daemon (ADR-130): the desktop app connects to a daemon running elsewhere on this computer's loopback, for
 * example in a dev container, instead of starting its own. The commands are in
 * `apps/desktop/src-tauri/src/remote_daemon.rs`; both switches restart the app. Tauri window only.
 */
const PORT_COMMAND = "remote_daemon_port";
const USE_REMOTE_COMMAND = "use_remote_daemon";
const USE_OWN_COMMAND = "use_own_daemon";

/** The port of the remote daemon the app uses, or `null` when it runs its own. */
export async function remoteDaemonPort(): Promise<number | null> {
  return z
    .number()
    .int()
    .nullable()
    .parse(await invoke<unknown>(PORT_COMMAND));
}

/** Checks the daemon at the address of its page (`http://127.0.0.1:<port>/#token=…`), saves it and restarts the app. */
export function switchToRemoteDaemon(address: string): Promise<void> {
  return invoke(USE_REMOTE_COMMAND, { address });
}

/** Forgets the remote daemon and restarts the app with its own. */
export function switchToOwnDaemon(): Promise<void> {
  return invoke(USE_OWN_COMMAND);
}
