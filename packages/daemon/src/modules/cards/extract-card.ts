import type { Consumed, ConsumedHttp, Provided, RepoCard } from "@trackwall/protocol";
import type { CallFiles } from "./call-files.ts";
import { extractContracts } from "./endpoint-contracts.ts";
import { withReaches } from "./endpoint-reach.ts";
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
 * The repo card from one commit (§4.6, ADR-25, ADR-30): build system extractors, then tools from their build
 * directories, configuration and mise tasks (ADR-34), HTTP facts (Spring and frontend) with endpoint contracts and DTOs
 * (ADR-38), the client calls each endpoint reaches from the call files (ADR-82), and the list of mechanisms from what
 * the repo uses. The same commit gives the same card, unless the parsers did not produce a syntax tree in time
 * (`CardParsers.complete`, `CallFiles.complete`).
 */

/** A build system extractor together with the choice of files it reads, so that a new one cannot forget the other. */
const BUILD_EXTRACTORS = [
  { reads: readsMavenFile, extract: extractMaven },
  { reads: readsGradleFile, extract: extractGradle },
  { reads: readsNpmFile, extract: extractNpm },
];

/** HTTP fact extractors with the files they read; Java and Kotlin source files are chosen by the search (`JVM_SOURCE_PATTERN`). */
const HTTP_EXTRACTORS = [
  { reads: readsSpringConfigFile, extract: extractSpring },
  { reads: readsFrontendHttpFile, extract: extractFrontendHttp },
];

/** Whether some extractor reads file `path`; only such files (and the chosen source files) are taken from git when reading a commit. */
export function readsCardFile(path: string): boolean {
  return readsToolFile(path) || isMiseConfigFile(path) || [...BUILD_EXTRACTORS, ...HTTP_EXTRACTORS].some((e) => e.reads(path));
}

/**
 * The Java and Kotlin source files the Spring extractor reads: with mappings, HTTP clients or path constants, and the
 * files of the types they mention (DTOs, ADR-38).
 */
export const CARD_SOURCES: SourceSelection = {
  pattern: JVM_SOURCE_PATTERN,
  globs: JVM_SOURCE_GLOBS,
  accepts: isJvmSource,
  referencedTypes: referencedTypeNames,
};

/** The source files the endpoint reach reads (ADR-82): every Java and Kotlin file of app code, not only those from the search. */
export const CALL_SOURCES = isJvmSource;

export function extractCard(snapshot: RepoSnapshot, parsers: SyntaxParsers, calls: CallFiles): RepoCard {
  const mise = extractMiseSetup(snapshot);
  const builds = BUILD_EXTRACTORS.map((e) => e.extract(snapshot));
  const buildDirs = builds.flatMap((b) => b.buildFiles.map((f) => dirOf(f.path)));
  // Build extractors give only packages, and HTTP gives apps, endpoints and clients; the card keeps them together.
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
  const clients = consumes.filter((c): c is ConsumedHttp => c.kind === "http");
  return {
    commit: snapshot.commit,
    buildFiles: all.flatMap((e) => e.buildFiles),
    provides: withReaches(contracts.provides, clients, calls.files),
    consumes,
    dtos: contracts.dtos,
    reachTraced: calls.files !== null,
    tools: all.flatMap((e) => e.tools),
    mise: mise.mise,
    mechanisms: detectMechanisms(
      consumes.filter((c) => c.kind === "package"),
      snapshot.paths,
    ),
    problems: [...snapshot.problems, ...all.flatMap((e) => e.problems), ...mise.problems, ...contracts.problems, ...calls.problems],
  };
}

/** Every package once, with its first occurrence: the modules of a multi-module repo repeat the same dependencies. */
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
