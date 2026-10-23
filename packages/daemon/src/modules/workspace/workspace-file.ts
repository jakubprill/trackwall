import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type RepoHost, RepoHosts, type RepoTagRules, RepoTagRules as RepoTagRulesSchema } from "@trackwall/protocol";
import { type Document, isMap, parseDocument } from "yaml";
import { z } from "zod";
import { writeFileAtomic } from "../../atomic-write.ts";
import { DomainError } from "../../errors.ts";
import { isFullPath, NOT_FULL_PATH } from "./full-path.ts";

/**
 * `workspace.yaml` (§4.5, ADR-13): konfiguracja workspace, którą użytkownik może edytować ręcznie i trzymać
 * w prywatnym repo. Czytany przy każdym użyciu, więc ręczna edycja działa bez restartu daemona. Zapis zmienia
 * tylko jeden klucz (`projectsDir` albo `repoHosts`; `repoTags` tylko ręcznie) i zachowuje komentarze oraz pozostałe klucze, także nieczytaną
 * już listę `repos` z wersji 0.2.0 (ADR-18): to plik użytkownika, więc usunięcie jej zostawiamy jemu.
 */

/**
 * Klucze czytane osobno, więc zły wpis w jednym nie psuje drugiego: literówka w hostingach nie zabiera listy repo,
 * a komunikat mówi, który klucz poprawić.
 */
const Keys = {
  // Pusty klucz (`projectsDir:`) YAML czyta jako `null`, tak samo jak brak klucza.
  projectsDir: z
    .string()
    .refine((dir) => isFullPath(dir), NOT_FULL_PATH)
    .nullish()
    .transform((dir) => dir ?? null),
  // Hostingi repo (ADR-19); brak klucza to brak hostingów, bo adres GitLab zna tylko użytkownik.
  repoHosts: RepoHosts.nullish().transform((hosts) => hosts ?? []),
  // Reguły tagów repo (ADR-25); tylko ręcznie w pliku, bo nazwy zespołów i grup zna tylko użytkownik.
  repoTags: RepoTagRulesSchema.nullish().transform((rules) => rules ?? {}),
};
type Key = keyof typeof Keys;

export class WorkspaceFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Folder z projektami (ADR-18); `null`, dopóki nie jest ustawiony. */
  projectsDir(): string | null {
    return this.get("projectsDir", Keys.projectsDir);
  }

  /** Hostingi repo w kolejności z pliku (ADR-19). */
  repoHosts(): RepoHost[] {
    return this.get("repoHosts", Keys.repoHosts);
  }

  /** Reguły tagów repo (`repoTags`, ADR-25): tag i wzorce identyfikatora albo adresu repo zdalnego. */
  repoTagRules(): RepoTagRules {
    return this.get("repoTags", Keys.repoTags);
  }

  setProjectsDir(dir: string): void {
    this.set("projectsDir", dir);
  }

  setRepoHosts(hosts: RepoHost[]): void {
    this.set("repoHosts", hosts);
  }

  private get<T>(key: Key, schema: z.ZodType<T>): T {
    // `load` gwarantuje mapę albo pusty dokument.
    const config: Record<string, unknown> = this.load().toJS() ?? {};
    const parsed = schema.safeParse(config[key] ?? null);
    if (!parsed.success) throw this.invalid(`${key}: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  }

  private set(key: Key, value: unknown): void {
    const doc = this.load();
    doc.set(key, value);
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
