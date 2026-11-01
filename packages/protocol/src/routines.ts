import { z } from "zod";
import { Task, TaskApprovals, TaskModel, TaskPrompt, TaskTitle, visibleText } from "./agents.ts";
import { apiEndpoints, Done } from "./api.ts";
import { ContentDigest, fileName } from "./approved-file.ts";
import { SessionView } from "./conversation.ts";
import { RepoId } from "./workspace.ts";

/**
 * Contract of the `routines` module (ADR-173): a routine is a saved task the user runs by hand again and again, such as
 * "fetch the new OpenAPI spec, regenerate the client, compile and report". An agent writes it with `propose_routine`
 * after looking at the repo; it lies as a Markdown file in `.trackwall/routines` of the projects folder, and runs only
 * once the user has approved exactly that file's content: any change, by an agent or by hand, waits for approval again,
 * because a routine is a stored prompt that later runs without the user reading it. Running one creates an ordinary task.
 * Every action is `POST /api/routines/<action>`.
 */

/** The routine's name, also its file name without `.md`: lowercase words joined by `-`, e.g. `update-orders-client`. */
export const ROUTINE_NAME_MAX = 60;
export const RoutineName = fileName(ROUTINE_NAME_MAX, "a routine name");
export type RoutineName = z.infer<typeof RoutineName>;

/** SHA-256 of a routine file's bytes, in hex: what the user approved, and what an approval or a run names. */
export const RoutineDigest = ContentDigest;
export type RoutineDigest = z.infer<typeof RoutineDigest>;

/**
 * A routine as its file holds it. Title and prompt are checked like an agent's task proposal (`visibleText`) also when
 * read from the file, since anything with file tools in the projects folder can write it, and a hidden instruction must
 * not pass the user's review.
 */
export const Routine = z.object({
  name: RoutineName,
  title: visibleText(TaskTitle),
  repo: RepoId,
  /** Copilot CLI's model for the task (ADR-98); `null` for its default. */
  model: TaskModel.nullable(),
  /** The task's approvals mode (ADR-105); the user sees and approves it with the prompt. */
  approvals: TaskApprovals,
  /** The task's prompt: the file's body below the frontmatter. */
  prompt: visibleText(TaskPrompt),
});
export type Routine = z.infer<typeof Routine>;

/** A routine on the list: with its file's digest and whether the user approved exactly that content. */
export const RoutineEntry = Routine.extend({ digest: RoutineDigest, approved: z.boolean() });
export type RoutineEntry = z.infer<typeof RoutineEntry>;

/** A file of the routines folder the daemon could not read; it never runs, and the list goes on without it. */
export const RoutineProblem = z.object({ file: z.string(), message: z.string() });
export type RoutineProblem = z.infer<typeof RoutineProblem>;

export const RoutineList = z.object({
  /** By name. */
  routines: z.array(RoutineEntry),
  problems: z.array(RoutineProblem),
});
export type RoutineList = z.infer<typeof RoutineList>;

/** A routine as the user saw it: an approval or a run is refused when the file changed since (`bad_request`). */
const SeenRoutine = z.object({ name: RoutineName, digest: RoutineDigest }).strict();

const endpoint = apiEndpoints("routines");

export const routinesApi = {
  /** Every routine with whether it is approved; `projects_dir_unavailable` or `bad_request` without a projects folder. */
  list: endpoint("list", z.object({}).strict(), RoutineList),
  /** Approves the routine's content as the user read it. */
  approve: endpoint("approve", SeenRoutine, RoutineEntry),
  /** A new task from an approved routine, with the routine's title, repo, model and approvals mode, shown in `view`. */
  run: endpoint("run", SeenRoutine.extend({ view: SessionView.default("terminal") }), Task),
  /** Removes the routine's file and its approval. */
  remove: endpoint("remove", z.object({ name: RoutineName }).strict(), Done),
};
