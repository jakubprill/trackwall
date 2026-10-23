import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { type Document, isMap, parseDocument } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic-write.ts";
import { DomainError } from "../../errors.ts";

/**
 * `workspace.yaml` (§4.5, ADR-13): konfiguracja workspace, którą użytkownik może edytować ręcznie i trzymać
 * w prywatnym repo. Czytany przy każdym użyciu, więc ręczna edycja działa bez restartu daemona. Zapis zmienia
 * tylko klucz `projectsDir` i zachowuje komentarze oraz pozostałe klucze.
 */

const WorkspaceConfig = z.object({
  // Pusty klucz (`projectsDir:`) YAML czyta jako `null`, tak samo jak brak klucza.
  projectsDir: z
    .string()
    // Względna ścieżka zależałaby od katalogu, z którego uruchomiono daemon, a `~` nie jest rozwijane.
    .refine(isAbsolute, "folder z projektami musi być pełną ścieżką (bez `~` i bez ścieżki względnej)")
    .nullish()
    .transform((dir) => dir ?? null),
});

export class WorkspaceFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Folder z projektami (ADR-18); `null`, dopóki nie jest ustawiony. */
  projectsDir(): string | null {
    const parsed = WorkspaceConfig.safeParse(this.load().toJS() ?? {});
    if (!parsed.success) throw this.invalid(z.prettifyError(parsed.error));
    return parsed.data.projectsDir;
  }

  setProjectsDir(dir: string): void {
    const doc = this.load();
    doc.set("projectsDir", dir);
    this.save(doc);
  }

  private load(): Document {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      text = "";
    }
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw this.invalid(doc.errors.map((e) => e.message).join("; "));
    if (doc.contents !== null && !isMap(doc.contents)) throw this.invalid("plik musi być mapą kluczy, np. `projectsDir: <ścieżka>`");
    return doc;
  }

  private save(doc: Document): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileAtomic(this.path, doc.toString());
  }

  private invalid(details: string): DomainError {
    return new DomainError("invalid_config", `${this.path} jest niepoprawny: ${details}`);
  }
}
