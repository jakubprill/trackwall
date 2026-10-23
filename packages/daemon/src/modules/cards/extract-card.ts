import type { Consumed, RepoCard } from "@trackwall/protocol";
import { extractGradle, readsGradleFile } from "./gradle.ts";
import { extractMaven, readsMavenFile } from "./maven.ts";
import { detectMechanisms } from "./mechanisms.ts";
import { extractNpm, readsNpmFile } from "./npm.ts";
import { dirOf } from "./repo-path.ts";
import type { RepoSnapshot } from "./snapshot.ts";
import { extractTools, readsToolFile } from "./tools.ts";

/**
 * Karta repo z jednego commita (§4.6, ADR-25): ekstraktory systemów budowania, potem narzędzia z katalogów ich buildów
 * i spis mechanizmów z tego, czego repo używa. Czysta funkcja: ten sam commit daje tę samą kartę.
 */

const BUILD_EXTRACTORS = [extractMaven, extractGradle, extractNpm];
const FILE_READERS = [readsMavenFile, readsGradleFile, readsNpmFile, readsToolFile];

/** Czy któryś ekstraktor czyta plik `path`; tylko takie pliki odczyt commita wyciąga z gita. */
export function readsCardFile(path: string): boolean {
  return FILE_READERS.some((reads) => reads(path));
}

export function extractCard(snapshot: RepoSnapshot): RepoCard {
  const builds = BUILD_EXTRACTORS.map((extract) => extract(snapshot));
  const buildDirs = builds.flatMap((b) => b.buildFiles.map((f) => dirOf(f.path)));
  const all = [...builds, extractTools(snapshot, buildDirs)];
  const consumes = unique(all.flatMap((e) => e.consumes));
  return {
    commit: snapshot.commit,
    buildFiles: all.flatMap((e) => e.buildFiles),
    provides: all.flatMap((e) => e.provides),
    consumes,
    tools: all.flatMap((e) => e.tools),
    mechanisms: detectMechanisms(consumes, snapshot.paths),
    problems: [...snapshot.problems, ...all.flatMap((e) => e.problems)],
  };
}

/** Każda paczka raz, z pierwszym wystąpieniem: moduły wielomodułowego repo powtarzają te same zależności. */
function unique(consumes: Consumed[]): Consumed[] {
  const seen = new Set<string>();
  return consumes.filter((c) => {
    const key = `${c.ecosystem}:${c.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
