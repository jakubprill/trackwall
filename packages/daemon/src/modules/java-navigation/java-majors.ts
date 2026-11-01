import type { RepoCard } from "@trackwall/protocol";

/**
 * The Java versions to install for the repos' builds (ADR-167), from the versions their cards name: a build file's hint
 * (`17`, `1.8`, `21.0.2`) or a mise tool version (`temurin-17`, `corretto-21`), as major versions, each once, in order.
 * What names no version (`latest`, an unresolved `${java.version}`) and versions before 8 are left out.
 */
export function javaMajors(versions: readonly string[]): number[] {
  const majors = versions.flatMap((version) => {
    const major = /^(?:[a-z-]+-)?(?:1\.(?=\d))?(\d+)/.exec(version.trim())?.[1];
    return major === undefined || Number(major) < 8 ? [] : [Number(major)];
  });
  return [...new Set(majors)].sort((a, b) => a - b);
}

/** The Java versions the cards name, from a build file or a mise tool; a repo without a card names none. */
export function cardJavaVersions(cards: readonly (RepoCard | null)[]): string[] {
  return cards.flatMap((card) => (card?.tools ?? []).filter((tool) => tool.tool === "java").map((tool) => tool.version));
}
