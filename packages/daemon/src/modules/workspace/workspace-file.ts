import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { RepoId } from "@trackwall/protocol";
import { type Document, isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic-write.ts";
import { DomainError } from "../../errors.ts";

/**
 * `workspace.yaml` (§4.5, ADR-13): konfiguracja workspace, którą użytkownik może edytować ręcznie i trzymać
 * w prywatnym repo. Czytany przy każdym użyciu, więc ręczna edycja działa bez restartu daemona. Zapis zmienia
 * tylko listę `repos` i zachowuje komentarze oraz pozostałe klucze.
 */

export const WorkspaceRepoEntry = z.object({
  id: RepoId,
  // Względna ścieżka zależałaby od katalogu, z którego uruchomiono daemon, a `~` nie jest rozwijane.
  path: z.string().refine(isAbsolute, "ścieżka repo musi być pełna (bez `~` i bez ścieżki względnej)"),
});
export type WorkspaceRepoEntry = z.infer<typeof WorkspaceRepoEntry>;

const WorkspaceConfig = z.object({
  // Pusty klucz `repos:` (np. po ręcznym usunięciu wszystkich wpisów) YAML czyta jako `null`.
  repos: z
    .array(WorkspaceRepoEntry)
    .nullish()
    .transform((repos) => repos ?? [])
    .refine((repos) => new Set(repos.map((r) => r.id)).size === repos.length, "identyfikatory repo muszą być unikalne"),
});

export class WorkspaceFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  repos(): WorkspaceRepoEntry[] {
    const parsed = WorkspaceConfig.safeParse(this.load().toJS() ?? {});
    if (!parsed.success) throw this.invalid(z.prettifyError(parsed.error));
    return parsed.data.repos;
  }

  add(entry: WorkspaceRepoEntry): void {
    const doc = this.load();
    if (!isSeq(doc.get("repos"))) doc.set("repos", doc.createNode([]));
    doc.addIn(["repos"], doc.createNode(entry));
    this.save(doc);
  }

  /** `false`, gdy repo o tym identyfikatorze nie ma w pliku. */
  remove(id: string): boolean {
    const doc = this.load();
    const repos = doc.get("repos");
    if (!isSeq(repos)) return false;
    const index = repos.items.findIndex((item) => isMap(item) && item.get("id") === id);
    if (index < 0) return false;
    repos.delete(index);
    this.save(doc);
    return true;
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
    if (doc.contents !== null && !isMap(doc.contents)) throw this.invalid("plik musi być mapą z kluczem `repos`");
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
