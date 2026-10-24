import type { Consumed, Provided, RepoCard } from "@trackwall/protocol";
import { extractContracts } from "./endpoint-contracts.ts";
import { extractFrontendHttp, readsFrontendHttpFile } from "./frontend-http.ts";
import { extractGradle, readsGradleFile } from "./gradle.ts";
import { referencedTypeNames } from "./java-tokens.ts";
import { extractMaven, readsMavenFile } from "./maven.ts";
import { detectMechanisms } from "./mechanisms.ts";
import { extractMiseSetup, isMiseConfigFile } from "./mise-tasks.ts";
import { extractNpm, readsNpmFile } from "./npm.ts";
import type { SourceSelection } from "./read-snapshot.ts";
import { dirOf } from "./repo-path.ts";
import type { Extracted, RepoSnapshot } from "./snapshot.ts";
import { extractSpring, isJvmSource, JVM_SOURCE_GLOBS, JVM_SOURCE_PATTERN } from "./spring.ts";
import { readsSpringConfigFile } from "./spring-config.ts";
import type { SyntaxParsers } from "./syntax-tree.ts";
import { extractTools, readsToolFile } from "./tools.ts";

/**
 * Karta repo z jednego commita (§4.6, ADR-25, ADR-30): ekstraktory systemów budowania, potem narzędzia z katalogów ich
 * buildów, konfiguracja i taski mise (ADR-34), fakty HTTP (Spring i frontend) z kontraktami
 * endpointów i DTO (ADR-38) i spis mechanizmów z tego, czego repo używa. Ten sam commit daje tę samą kartę, chyba że
 * parsery nie dały drzewa składni w czasie (`CardParsers.complete`).
 */

/** Ekstraktor systemu budowania razem z wyborem plików, które czyta, żeby nowy nie mógł zapomnieć o drugim. */
const BUILD_EXTRACTORS = [
  { reads: readsMavenFile, extract: extractMaven },
  { reads: readsGradleFile, extract: extractGradle },
  { reads: readsNpmFile, extract: extractNpm },
];

/** Ekstraktory faktów HTTP z plikami, które czytają; pliki źródłowe Javy i Kotlina wybiera wyszukiwanie (`JVM_SOURCE_PATTERN`). */
const HTTP_EXTRACTORS = [
  { reads: readsSpringConfigFile, extract: extractSpring },
  { reads: readsFrontendHttpFile, extract: extractFrontendHttp },
];

/** Czy któryś ekstraktor czyta plik `path`; tylko takie pliki (i wybrane pliki źródłowe) odczyt commita wyciąga z gita. */
export function readsCardFile(path: string): boolean {
  return readsToolFile(path) || isMiseConfigFile(path) || [...BUILD_EXTRACTORS, ...HTTP_EXTRACTORS].some((e) => e.reads(path));
}

/**
 * Pliki źródłowe Javy i Kotlina, które czyta ekstraktor Spring: z mapowaniami, klientami HTTP albo stałymi ścieżek,
 * i pliki typów, które wymieniają (DTO, ADR-38).
 */
export const CARD_SOURCES: SourceSelection = {
  pattern: JVM_SOURCE_PATTERN,
  globs: JVM_SOURCE_GLOBS,
  accepts: isJvmSource,
  referencedTypes: referencedTypeNames,
};

export function extractCard(snapshot: RepoSnapshot, parsers: SyntaxParsers): RepoCard {
  const mise = extractMiseSetup(snapshot);
  const builds = BUILD_EXTRACTORS.map((e) => e.extract(snapshot));
  const buildDirs = builds.flatMap((b) => b.buildFiles.map((f) => dirOf(f.path)));
  // Ekstraktory buildu dają tylko paczki, a HTTP aplikacje, endpointy i klientów; karta trzyma je razem.
  const all: Extracted<Provided, Consumed>[] = [
    ...builds,
    extractTools(snapshot, buildDirs),
    ...HTTP_EXTRACTORS.map((e) => e.extract(snapshot)),
  ];
  const consumes = unique(all.flatMap((e) => e.consumes));
  const contracts = extractContracts(
    snapshot,
    all.flatMap((e) => e.provides),
    parsers,
  );
  return {
    commit: snapshot.commit,
    buildFiles: all.flatMap((e) => e.buildFiles),
    provides: contracts.provides,
    consumes,
    dtos: contracts.dtos,
    tools: all.flatMap((e) => e.tools),
    mise: mise.mise,
    mechanisms: detectMechanisms(
      consumes.filter((c) => c.kind === "package"),
      snapshot.paths,
    ),
    problems: [...snapshot.problems, ...all.flatMap((e) => e.problems), ...mise.problems, ...contracts.problems],
  };
}

/** Każda paczka raz, z pierwszym wystąpieniem: moduły wielomodułowego repo powtarzają te same zależności. */
function unique(consumes: Consumed[]): Consumed[] {
  const seen = new Set<string>();
  return consumes.filter((c) => {
    if (c.kind !== "package") return true;
    const key = `${c.ecosystem}:${c.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
