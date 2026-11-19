import { TerminalPlace } from "@trackwall/protocol";
import { z } from "zod";
import { FollowedStateFile, stateFormat } from "../../infra/state-file.ts";

/**
 * The places whose folder terminal runs, kept in a file of the state directory so that the next daemon opens a new
 * shell in each (§4.23): a shell is a process and ends with the daemon, but where it ran is what the user would open
 * again by hand. The file follows the places while the daemon works and stops following them once the daemon stops,
 * so the shells its stop ends stay in it; after a crash it holds those of the last start or close.
 */

export const SHELL_PLACES_FILE = "folder-terminals.json";

const ShellPlacesFile = z.object({ places: z.array(TerminalPlace) });
/** `folder-terminals.json` (ADR-283, ADR-223). */
export const SHELL_PLACES_FORMAT = stateFormat(ShellPlacesFile);

/** What `FolderTerminals` needs of the file; a fake in unit tests. */
export interface ShellPlacesStore {
  /** The places the previous daemon left; none when there is no file, and none from a broken one, which is moved aside. */
  read(): TerminalPlace[];
  /** The places whose shell runs now; nothing once the daemon stops. */
  follow(places: readonly TerminalPlace[]): void;
  stopFollowing(): void;
}

export class ShellPlaces implements ShellPlacesStore {
  readonly #file: FollowedStateFile<z.infer<typeof ShellPlacesFile>>;

  constructor(path: string, log: (msg: string) => void) {
    this.#file = new FollowedStateFile(path, SHELL_PLACES_FORMAT, {
      broken: (problem, aside) => log(`${path}: ${problem}; file moved to ${aside}, no shell opens again`),
      log,
    });
  }

  read(): TerminalPlace[] {
    return this.#file.read()?.places ?? [];
  }

  follow(places: readonly TerminalPlace[]): void {
    this.#file.follow({ places: [...places] });
  }

  stopFollowing(): void {
    this.#file.stopFollowing();
  }
}
