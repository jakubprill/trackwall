import { readFileSync, renameSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";

/**
 * `runtime.json` (§4.1): the register of live process groups, so that the next daemon start can clean up orphans after
 * a crash or a hard kill. A group goes into the file after its start and leaves it once it is confirmed dead.
 */

const RuntimeGroup = z.object({
  runId: z.string(),
  owner: z.string(),
  command: z.array(z.string()),
  cwd: z.string(),
  startedAt: z.string(),
  pid: z.number().int().positive(),
  /** The leader's start time according to the system (`GroupPlatform.identity`); `null` when the system does not give it. */
  identity: z.string().nullable(),
});
export type RuntimeGroup = z.infer<typeof RuntimeGroup>;

const RuntimeFileSchema = z.object({ groups: z.array(RuntimeGroup) });

export class RuntimeFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** A missing file means no groups. A file that fails the schema is an error: without it, nobody knows what to clean up. */
  read(): RuntimeGroup[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${this.path}: not JSON`);
    }
    const parsed = RuntimeFileSchema.safeParse(json);
    if (!parsed.success) throw new Error(`${this.path}: ${z.prettifyError(parsed.error)}`);
    return parsed.data.groups;
  }

  /** Moves an unreadable file aside (`runtime.json.broken-<time>`) and returns the new path. */
  moveAside(): string {
    const aside = `${this.path}.broken-${Date.now()}`;
    renameSync(this.path, aside);
    return aside;
  }

  write(groups: readonly RuntimeGroup[]): void {
    writeFileAtomic(this.path, `${JSON.stringify({ groups }, null, 2)}\n`);
  }
}
