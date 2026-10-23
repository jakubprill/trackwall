import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RepoId } from "@pitwall/protocol";
import { isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { DomainError } from "../../errors.ts";

/**
 * `workspace.yaml` (§6): konfiguracja workspace, którą użytkownik może edytować ręcznie i trzymać w prywatnym repo.
 * Czytany przy każdym użyciu, więc ręczna edycja działa bez restartu daemona. Zapis zmienia tylko listę `repos`
 * i zachowuje komentarze oraz pozostałe klucze.
 */

export const WorkspaceRepoEntry = z.object({ id: RepoId, path: z.string().min(1) });
export type WorkspaceRepoEntry = z.infer<typeof WorkspaceRepoEntry>;

const WorkspaceConfig = z
  .object({ repos: z.array(WorkspaceRepoEntry).default([]) })
  .refine((c) => new Set(c.repos.map((r) => r.id)).size === c.repos.length, "identyfikatory repo w `repos` muszą być unikalne");

export class WorkspaceFile {
  constructor(readonly path: string) {}

  repos(): WorkspaceRepoEntry[] {
    const doc = this.load();
    const parsed = WorkspaceConfig.safeParse(doc.toJS() ?? {});
    if (!parsed.success) throw this.invalid(parsed.error.issues.map((i) => `${i.path.join(".") || "(korzeń)"}: ${i.message}`).join("; "));
    return parsed.data.repos;
  }

  add(entry: WorkspaceRepoEntry): void {
    const doc = this.load();
    if (!isSeq(doc.get("repos"))) doc.set("repos", doc.createNode([]));
    doc.addIn(["repos"], doc.createNode(entry));
    this.save(doc.toString());
  }

  /** `false`, gdy repo o tym identyfikatorze nie ma w pliku. */
  remove(id: string): boolean {
    const doc = this.load();
    const repos = doc.get("repos");
    if (!isSeq(repos)) return false;
    const index = repos.items.findIndex((item) => isMap(item) && item.get("id") === id);
    if (index < 0) return false;
    repos.delete(index);
    this.save(doc.toString());
    return true;
  }

  private load() {
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

  /** Atomowo (plik tymczasowy + rename): przerwany zapis nie zostawia uciętego pliku. */
  private save(text: string): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, this.path);
  }

  private invalid(details: string): DomainError {
    return new DomainError("invalid_config", `${this.path} jest niepoprawny: ${details}`);
  }
}
