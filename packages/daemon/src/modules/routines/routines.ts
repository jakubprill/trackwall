import type { Routine, RoutineDigest, RoutineEntry, RoutineList, RoutineName } from "@trackwall/protocol";
import { type ApprovedFile, ApprovedFolder } from "../../infra/approved-folder.ts";
import { DomainError } from "../../infra/errors.ts";
import { ensureTrackwallDir } from "../../infra/trackwall-dir.ts";
import { ROUTINE_FILE_FORMAT, writeRoutineFile } from "./routine-file.ts";

/**
 * Routines (ADR-173, §4.20): saved tasks the user runs by hand, as files in `.trackwall/routines` of the projects folder
 * beside the board, so they survive a rebuilt container and the user reads them in an editor. A routine is a stored
 * prompt that later runs without the user reading it again, so the daemon runs only content the user approved
 * (`ApprovedFolder`: the SHA-256 of the file's bytes, kept in the state folder, and an approval or a run names the digest
 * the user saw). Nothing here starts a task; the facade does, from `approved`.
 */

/** Routines an agent may save, below the files read, so a loop is refused before the list stops reading the user's own. */
const MAX_ROUTINES = 100;

export interface RoutinesDeps {
  /** The projects folder; refused (`bad_request`, `projects_dir_unavailable`) when it is not set or not there. */
  projectsDir: () => Promise<string>;
  /** `routine-approvals.json` in the state folder. */
  approvalsFile: string;
  log: (msg: string) => void;
}

export class Routines {
  readonly #folder: ApprovedFolder<Routine>;

  constructor(deps: RoutinesDeps) {
    this.#folder = new ApprovedFolder({
      format: ROUTINE_FILE_FORMAT,
      dir: async () => ensureTrackwallDir(await deps.projectsDir(), "routines"),
      approvalsFile: deps.approvalsFile,
      log: deps.log,
    });
  }

  async list(): Promise<RoutineList> {
    const { files, problems } = await this.#folder.list();
    return { routines: files.map(entry), problems };
  }

  /** Writes the routine an agent proposed (`propose_routine`); it waits for approval unless its bytes are the approved ones. */
  async save(routine: Routine): Promise<RoutineEntry> {
    const { files } = await this.#folder.list();
    if (!files.some((f) => f.name === routine.name) && files.length >= MAX_ROUTINES)
      throw new DomainError("bad_request", `${MAX_ROUTINES} routines are saved, the limit; ask the user to remove some first`);
    const written = await this.#folder.write(routine.name, writeRoutineFile(routine), { approve: false });
    return { ...routine, ...written };
  }

  /** Approves the routine's content as the user saw it (`digest`). */
  async approve(name: RoutineName, digest: RoutineDigest): Promise<RoutineEntry> {
    return entry(await this.#folder.approve(name, digest));
  }

  /** The routine to run: refused unless its file is still what the user saw and approved. */
  async approved(name: RoutineName, digest: RoutineDigest): Promise<Routine> {
    const read = await this.#folder.seen(name, digest);
    if (!read.approved) throw new DomainError("bad_request", `routine ${name} is not approved in this version; approve it first`);
    return read.value;
  }

  remove(name: RoutineName): Promise<void> {
    return this.#folder.remove(name);
  }
}

function entry({ value, digest, approved }: ApprovedFile<Routine>): RoutineEntry {
  return { ...value, digest, approved };
}
