import { z } from "zod";
import type { Endpoint } from "./api.ts";
import { RepoId } from "./workspace.ts";

/**
 * Kontrakt modułu `cards` (§4.6, ADR-25): karta repo, czyli fakty wyciągnięte deterministycznie z plików buildu
 * i konfiguracji w ostatnim commicie, oraz tagi repo policzone z karty i z reguł w `workspace.yaml`. Każda akcja to
 * `POST /api/cards/<akcja>`. Bez LLM: każde pole ma dowód (plik i linię).
 */

/** Plik i linia w drzewie commita, z których wynika fakt; `line` `null`, gdy fakt dotyczy całego pliku. */
export const Evidence = z.object({
  path: z.string(),
  line: z.number().int().positive().nullable(),
});
export type Evidence = z.infer<typeof Evidence>;

/** Dowód jako `ścieżka:linia`, a bez linii sama ścieżka; jeden zapis w powodach tagów i w UI. */
export function evidenceLabel(evidence: Evidence): string {
  return evidence.line === null ? evidence.path : `${evidence.path}:${evidence.line}`;
}

/**
 * System budowania albo menedżer paczek, którego plik buildu jest w repo. `npm`, `pnpm`, `yarn` i `bun` rozróżnia
 * pole `packageManager` albo plik blokady w katalogu z `package.json`.
 */
export const BuildTool = z.enum(["maven", "gradle", "npm", "pnpm", "yarn", "bun"]);
export type BuildTool = z.infer<typeof BuildTool>;

/** Plik buildu, który należy do buildu repo: korzeń i moduły albo paczki z niego wymienione. */
export const BuildFile = z.object({
  path: z.string(),
  tool: BuildTool,
  /** Nazwa z pliku (`artifactId`, `name` z `package.json`, nazwa projektu Gradle); `null`, gdy jej nie ma. */
  name: z.string().nullable(),
  /** Plik buildu, który wymienia ten jako moduł albo paczkę workspace; `null` dla korzenia buildu. */
  memberOf: z.string().nullable(),
});
export type BuildFile = z.infer<typeof BuildFile>;

/**
 * Przestrzeń nazw paczek: współrzędne Maven (`grupa:artefakt`, także z Gradle), nazwy npm i identyfikatory wtyczek
 * Gradle. Krawędzie grafu łączą to, co repo udostępnia, z tym, czego używa inne, w tej samej przestrzeni.
 */
export const PackageEcosystem = z.enum(["maven", "npm", "gradle-plugin"]);
export type PackageEcosystem = z.infer<typeof PackageEcosystem>;

/** Paczka, którą repo buduje i którą inne repo może wziąć jako zależność. */
export const ProvidedPackage = z.object({
  kind: z.literal("package"),
  ecosystem: PackageEcosystem,
  name: z.string(),
  /** Wersja z pliku buildu po podstawieniu właściwości; `null`, gdy plik jej nie podaje. */
  version: z.string().nullable(),
  evidence: Evidence,
});
export type ProvidedPackage = z.infer<typeof ProvidedPackage>;

/** Paczka spoza repo, której repo używa: zależność, rodzic Maven, BOM, wtyczka buildu. */
export const ConsumedPackage = ProvidedPackage.extend({
  /**
   * Ten sam typ co w `ProvidedPackage`, inne znaczenie: wersja tak, jak stoi w pliku (zakres npm, właściwość Maven,
   * której nie dało się podstawić); `null` bez wersji.
   */
  version: z.string().nullable(),
  /**
   * Rodzaj użycia z pliku: zakres Maven (`compile`, `test`, `import`…), `parent`, `plugin`, konfiguracja Gradle
   * (`implementation`…) albo pole `package.json` (`dependencies`, `devDependencies`…).
   */
  scope: z.string(),
});
export type ConsumedPackage = z.infer<typeof ConsumedPackage>;

/** Co repo udostępnia; dziś paczki, potem endpointy HTTP i topiki (§4.6). */
export const Provided = z.discriminatedUnion("kind", [ProvidedPackage]);
export type Provided = z.infer<typeof Provided>;

/** Czego repo używa; dziś paczki, potem wywołania HTTP, topiki i zmienne z adresami (§4.6). */
export const Consumed = z.discriminatedUnion("kind", [ConsumedPackage]);
export type Consumed = z.infer<typeof Consumed>;

/** Wersja narzędzia, której repo wymaga: z konfiguracji mise albo z pliku, który podaje ją po swojemu. */
export const ToolRequirement = z.object({
  /** Nazwa narzędzia tak, jak zna ją mise (`java`, `node`, `pnpm`, `maven`…). */
  tool: z.string(),
  version: z.string(),
  /**
   * `mise`: `[tools]` w konfiguracji mise albo `.tool-versions`, które mise czyta wprost. `hint`: wersja z innego
   * pliku (`.nvmrc`, `engines.node`, `maven.compiler.release`…), którą mise może, ale nie musi brać pod uwagę.
   */
  source: z.enum(["mise", "hint"]),
  evidence: Evidence,
});
export type ToolRequirement = z.infer<typeof ToolRequirement>;

/**
 * Mechanizm wykryty w repo: framework, sposób komunikacji albo wdrożenia. Spis, bez oceny: mówi, że repo go używa,
 * a dowody mówią skąd to wiadomo.
 */
export const MechanismId = z.enum([
  "spring-boot",
  "feign",
  "webclient",
  "openapi",
  "kafka",
  "rabbitmq",
  "eureka",
  "config-server",
  "config-client",
  "kubernetes",
  "helm",
  "docker",
  "react",
  "angular",
  "vue",
  "svelte",
  "express",
  "nestjs",
]);
export type MechanismId = z.infer<typeof MechanismId>;

export const MechanismEvidence = Evidence.extend({
  /** Co w tym miejscu wskazuje mechanizm, np. `org.springframework.cloud:spring-cloud-starter-openfeign`. */
  detail: z.string(),
});
export type MechanismEvidence = z.infer<typeof MechanismEvidence>;

export const Mechanism = z.object({
  id: MechanismId,
  /** Najwyżej kilka pierwszych dowodów; jeden wystarcza, żeby mechanizm był na karcie. */
  evidence: z.array(MechanismEvidence).min(1),
});
export type Mechanism = z.infer<typeof Mechanism>;

/** Plik buildu albo konfiguracji, którego ekstraktor nie umiał przeczytać; reszta karty powstaje bez niego. */
export const CardProblem = z.object({ path: z.string(), message: z.string() });
export type CardProblem = z.infer<typeof CardProblem>;

/**
 * Karta repo dla jednego commita. Zależy tylko od drzewa commita, więc daemon liczy ją raz na commit i trzyma
 * w pamięci podręcznej (ADR-25).
 */
export const RepoCard = z.object({
  /** Pełny hash commita, z którego czytano pliki. */
  commit: z.string(),
  buildFiles: z.array(BuildFile),
  /** Paczki z repo, bez prywatnych paczek npm (`"private": true`), których nikt spoza repo nie zainstaluje. */
  provides: z.array(Provided),
  /** Paczki spoza repo, każda raz (pierwsze wystąpienie); paczki z tego samego repo pominięte. */
  consumes: z.array(Consumed),
  tools: z.array(ToolRequirement),
  mechanisms: z.array(Mechanism),
  problems: z.array(CardProblem),
});
export type RepoCard = z.infer<typeof RepoCard>;

/** Nazwa tagu: małe litery, cyfry i `-`, jak `frontend` albo `core-api`; w UI z `#` z przodu. */
export const TagName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "nazwa tagu: małe litery, cyfry i '-', bez '-' na początku");
export type TagName = z.infer<typeof TagName>;

/** Tag repo z powodem, dla którego repo go dostało (zdanie dla człowieka, np. „zależność react w package.json”). */
export const RepoTag = z.object({ name: TagName, reason: z.string() });
export type RepoTag = z.infer<typeof RepoTag>;

/**
 * Reguły tagów z `workspace.yaml` (`repoTags`): tag i wzorce, z których wystarczy jeden pasujący do identyfikatora
 * repo albo adresu repo zdalnego. `*` to dowolny ciąg bez `/`, `**` także z `/`, np. `core-api: ["*-core",
 * "gitlab.example.com/core/**"]`. Tak firmowe nazwy zespołów i grup zostają w konfiguracji użytkownika (ADR-7).
 */
export const RepoTagRules = z.record(TagName, z.array(z.string().min(1).max(300)).min(1));
export type RepoTagRules = z.infer<typeof RepoTagRules>;

export const RepoCardResult = z.object({
  repo: RepoId,
  /** `null` w repo bez commitów: nie ma z czego czytać. */
  card: RepoCard.nullable(),
  /** Tagi z karty i z reguł `repoTags`, po nazwie. */
  tags: z.array(RepoTag),
});
export type RepoCardResult = z.infer<typeof RepoCardResult>;

/** Tagi jednego repo z listy albo powód, dla którego ich nie ma (git nie czyta repo). */
export const RepoTags = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), repo: RepoId, tags: z.array(RepoTag) }),
  z.object({ kind: z.literal("unavailable"), repo: RepoId, message: z.string() }),
]);
export type RepoTags = z.infer<typeof RepoTags>;

function endpoint<Req extends z.ZodType, Data extends z.ZodType>(action: string, request: Req, data: Data): Endpoint<Req, Data> {
  return { path: `/api/cards/${action}`, request, data };
}

export const cardsApi = {
  /** Karta repo z ostatniego commita; pierwsze pytanie o commit czyta pliki z gita, następne biorą ją z pamięci. */
  card: endpoint("card", z.object({ repo: RepoId }).strict(), RepoCardResult),
  /** Tagi każdego repo z folderu z projektami, w kolejności listy repo. */
  tags: endpoint("tags", z.object({}).strict(), z.array(RepoTags)),
};
