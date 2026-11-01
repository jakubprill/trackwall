import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type Routine, RoutineDigest, type RoutineEntry, type RoutineList, RoutineName, type RoutineProblem } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { DomainError, messageOf } from "../../infra/errors.ts";
import { mapLimit } from "../../infra/map-limit.ts";
import { readRegularFile } from "../../infra/regular-file.ts";
import { readStateFile } from "../../infra/state-file.ts";
import { ensureTrackwallDir } from "../../infra/trackwall-dir.ts";
import { readRoutineFile, routineFileName, routineNameOfFile, writeRoutineFile } from "./routine-file.ts";

/**
 * Routines (ADR-173, §4.19): saved tasks the user runs by hand, as files in `.trackwall/routines` of the projects folder
 * beside the board, so they survive a rebuilt container and the user reads them in an editor. A routine is a stored
 * prompt that later runs without the user reading it again, and anything with file tools in the projects folder can
 * write the folder, so the daemon runs only content the user approved: the approval is the SHA-256 of the file's bytes,
 * kept in the state folder, and an approval or a run names the digest the user saw, so a file changed in between is
 * refused instead of approved or run unseen. Nothing here starts a task; the facade does, from `approved`.
 */

/** Enough for a prompt of `TASK_PROMPT_MAX` characters in any script, with its frontmatter. */
const MAX_ROUTINE_FILE_BYTES = 64 * 1024;
/** Files read at most; more is a sign of something other than the user's routines, and the rest is a problem. */
const MAX_ROUTINE_FILES = 200;
/** Routines an agent may save, below the files read, so a loop is refused before the list stops reading the user's own. */
const MAX_ROUTINES = 100;
const READ_AT_ONCE = 16;

/** `routine-approvals.json`: the approved digest of each routine by name. */
const StoredApprovals = z.object({ approved: z.record(RoutineName, RoutineDigest) });
type StoredApprovals = z.infer<typeof StoredApprovals>;

export interface RoutinesDeps {
  /** The projects folder; refused (`bad_request`, `projects_dir_unavailable`) when it is not set or not there. */
  projectsDir: () => Promise<string>;
  /** `routine-approvals.json` in the state folder. */
  approvalsFile: string;
  log: (msg: string) => void;
}

/** A routine read from its file, with the digest of the bytes it was read from. */
type ReadRoutine = { routine: Routine; digest: string };

export class Routines {
  readonly #deps: RoutinesDeps;

  constructor(deps: RoutinesDeps) {
    this.#deps = deps;
  }

  async list(): Promise<RoutineList> {
    const { routines, problems } = await readRoutines(await this.#dir());
    const { approved } = this.#approvals();
    return { routines: routines.map((read) => entry(read, approved)), problems };
  }

  /** Writes the routine an agent proposed (`propose_routine`); it waits for approval unless its bytes are the approved ones. */
  async save(routine: Routine): Promise<RoutineEntry> {
    const dir = await this.#dir();
    const { routines } = await readRoutines(dir);
    if (!routines.some((r) => r.routine.name === routine.name) && routines.length >= MAX_ROUTINES)
      throw new DomainError("bad_request", `${MAX_ROUTINES} routines are saved, the limit; ask the user to remove some first`);
    const text = writeRoutineFile(routine);
    writeFileAtomic(join(dir, routineFileName(routine.name)), text);
    return entry({ routine, digest: digestOf(Buffer.from(text, "utf8")) }, this.#approvals().approved);
  }

  /** Approves the routine's content as the user saw it (`digest`). */
  async approve(name: RoutineName, digest: RoutineDigest): Promise<RoutineEntry> {
    const read = await this.#seen(name, digest);
    const approvals = this.#approvals();
    this.#writeApprovals({ approved: { ...approvals.approved, [name]: digest } });
    return entry(read, { [name]: digest });
  }

  /** The routine to run: refused unless its file is still what the user saw and approved. */
  async approved(name: RoutineName, digest: RoutineDigest): Promise<Routine> {
    const { routine } = await this.#seen(name, digest);
    if (this.#approvals().approved[name] !== digest)
      throw new DomainError("bad_request", `routine ${name} is not approved in this version; approve it first`);
    return routine;
  }

  async remove(name: RoutineName): Promise<void> {
    await rm(join(await this.#dir(), routineFileName(name)), { force: true });
    const { [name]: _, ...approved } = this.#approvals().approved;
    this.#writeApprovals({ approved });
  }

  /** The routine as its file is now, refused when that is no longer the content the user saw. */
  async #seen(name: RoutineName, digest: RoutineDigest): Promise<ReadRoutine> {
    const read = await readRoutine(join(await this.#dir(), routineFileName(name)), name);
    if (read === undefined) throw new DomainError("not_found", `no routine ${name}`);
    if ("problem" in read) throw new DomainError("bad_request", `routine ${name} cannot be read: ${read.problem}`);
    if (read.digest !== digest)
      throw new DomainError("bad_request", `routine ${name} changed since you read it; check the new version first`);
    return read;
  }

  #approvals(): StoredApprovals {
    return (
      readStateFile(this.#deps.approvalsFile, StoredApprovals, (problem, aside) =>
        this.#deps.log(`routine approvals were unreadable (${problem}), moved to ${aside}; every routine waits for approval again`),
      ) ?? { approved: {} }
    );
  }

  #writeApprovals(approvals: StoredApprovals): void {
    writeFileAtomic(this.#deps.approvalsFile, `${JSON.stringify(approvals, null, 2)}\n`);
  }

  /** The folder, made where missing; a link in its place is refused (`ensureTrackwallDir`). */
  async #dir(): Promise<string> {
    return ensureTrackwallDir(await this.#deps.projectsDir(), "routines");
  }
}

function digestOf(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function entry({ routine, digest }: ReadRoutine, approved: Record<string, string>): RoutineEntry {
  return { ...routine, digest, approved: approved[routine.name] === digest };
}

/** `undefined` when there is no file; a problem for one that holds no routine. */
async function readRoutine(path: string, name: RoutineName): Promise<ReadRoutine | { problem: string } | undefined> {
  try {
    const bytes = await readRegularFile(path, MAX_ROUTINE_FILE_BYTES);
    if (bytes === undefined) return undefined;
    const file = readRoutineFile(name, bytes.toString("utf8"));
    return "problem" in file ? file : { routine: file.routine, digest: digestOf(bytes) };
  } catch (err) {
    return { problem: messageOf(err) };
  }
}

/** Every routine file of the folder by name, a few at a time; a file that holds no routine is a problem. */
async function readRoutines(dir: string): Promise<{ routines: ReadRoutine[]; problems: RoutineProblem[] }> {
  const files = (await readdir(dir)).sort().flatMap((file) => {
    const name = routineNameOfFile(file);
    return name === undefined ? [] : [{ file, name }];
  });
  const read = await mapLimit(files.slice(0, MAX_ROUTINE_FILES), READ_AT_ONCE, async ({ file, name }) => ({
    file,
    read: await readRoutine(join(dir, file), name),
  }));
  const routines: ReadRoutine[] = [];
  const problems: RoutineProblem[] = [];
  for (const { file, read: one } of read) {
    // A file removed between the folder's listing and its read is simply gone.
    if (one === undefined) continue;
    if ("problem" in one) problems.push({ file, message: one.problem });
    else routines.push(one);
  }
  if (files.length > MAX_ROUTINE_FILES)
    problems.push({ file: files[MAX_ROUTINE_FILES]?.file ?? "", message: `the list reads at most ${MAX_ROUTINE_FILES} files` });
  return { routines, problems };
}
