import { readFileSync, renameSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic-write.ts";

/**
 * `runtime.json` (§4.1): rejestr żywych grup procesów, żeby następny start daemona mógł posprzątać sieroty po
 * awarii albo twardym zabiciu. Grupa trafia do pliku po starcie i znika z niego po potwierdzeniu, że nie żyje.
 */

const RuntimeGroup = z.object({
  runId: z.string(),
  owner: z.string(),
  command: z.array(z.string()),
  cwd: z.string(),
  startedAt: z.string(),
  pid: z.number().int().positive(),
  /** Czas startu lidera według systemu (`GroupPlatform.identity`); `null`, gdy system go nie podaje. */
  identity: z.string().nullable(),
});
export type RuntimeGroup = z.infer<typeof RuntimeGroup>;

const RuntimeFileSchema = z.object({ groups: z.array(RuntimeGroup) });

export class RuntimeFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Brak pliku to brak grup. Plik, który nie przechodzi schematu, jest błędem: bez niego nie wiadomo, co sprzątać. */
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

  /** Przenosi nieczytelny plik obok (`runtime.json.broken-<czas>`) i zwraca nową ścieżkę. */
  moveAside(): string {
    const aside = `${this.path}.broken-${Date.now()}`;
    renameSync(this.path, aside);
    return aside;
  }

  write(groups: readonly RuntimeGroup[]): void {
    writeFileAtomic(this.path, `${JSON.stringify({ groups }, null, 2)}\n`);
  }
}
