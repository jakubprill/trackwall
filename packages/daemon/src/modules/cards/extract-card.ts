import type { Consumed, RepoCard } from "@trackwall/protocol";
import { extractGradle } from "./gradle.ts";
import { extractMaven } from "./maven.ts";
import { detectMechanisms } from "./mechanisms.ts";
import { extractNpm } from "./npm.ts";
import { dirOf, type RepoSnapshot } from "./snapshot.ts";
import { extractTools } from "./tools.ts";

/**
 * Karta repo z jednego commita (§4.6, ADR-25): ekstraktory systemów budowania, potem narzędzia z katalogów ich buildów
 * i spis mechanizmów z tego, czego repo używa. Czysta funkcja: ten sam commit daje tę samą kartę.
 */
export function extractCard(snapshot: RepoSnapshot): RepoCard {
  const builds = [extractMaven(snapshot), extractGradle(snapshot), extractNpm(snapshot)];
  const buildFiles = builds.flatMap((b) => b.buildFiles);
  const provides = builds.flatMap((b) => b.provides);
  const tools = extractTools(
    snapshot,
    buildFiles.map((f) => dirOf(f.path)),
  );
  const consumes = unique(builds.flatMap((b) => b.consumes));
  return {
    commit: snapshot.commit,
    buildFiles,
    provides,
    consumes,
    tools: [...tools.tools, ...builds.flatMap((b) => b.tools)],
    mechanisms: detectMechanisms(consumes, snapshot.paths),
    problems: [...builds.flatMap((b) => b.problems), ...tools.problems],
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
