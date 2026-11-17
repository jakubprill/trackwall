import type {
  BuildFile,
  ConsumedHttp,
  ConsumedPackage,
  Dto,
  Mechanism,
  ProvidedApp,
  ProvidedEndpoint,
  ProvidedPackage,
  RepoCard,
  RepoTag,
  ToolRequirement,
} from "@trackwall/protocol";

/**
 * The sections of the "Card" tab under "At a glance" (ADR-267): each kind of fact the card holds is one section, folded
 * until asked for, with the number of its facts. A kind the repo has no fact of is no section: all of them stand in one
 * folded line at the end, which says for each what Trackwall looked for.
 */

/** The sections in the order the card lists them. */
const SECTION_IDS = ["tags", "mechanisms", "tools", "apps", "endpoints", "dtos", "clients", "provides", "uses", "build-files"] as const;

export type CardSectionId = (typeof SECTION_IDS)[number];

/** A section's name and what its absence means. */
export const CARD_SECTIONS: Record<CardSectionId, { label: string; missing: string }> = {
  tags: { label: "Tags", missing: "No tags. Add your own tags with the repoTags key in workspace.yaml." },
  mechanisms: { label: "Mechanisms", missing: "No framework, messaging or deployment recognized." },
  tools: {
    label: "Required tools",
    missing: "The repo does not pin tool versions (mise, .tool-versions, .nvmrc, Maven or Gradle wrapper).",
  },
  apps: { label: "Apps", missing: "No Spring Boot app found." },
  endpoints: { label: "HTTP endpoints", missing: "No @RestController or @Controller controllers or OpenAPI specs found." },
  dtos: { label: "DTOs", missing: "No request or response types of endpoints found." },
  clients: { label: "HTTP clients", missing: "No HTTP client found." },
  provides: { label: "Provides", missing: "The repo does not build a package that another repo could use." },
  uses: { label: "Uses", missing: "No dependencies in the build files." },
  "build-files": { label: "Build files", missing: "No pom.xml, build.gradle or package.json found." },
};

/** The card's facts by section; the facts of a section with none are an empty list. */
export interface CardFacts {
  tags: readonly RepoTag[];
  mechanisms: Mechanism[];
  tools: ToolRequirement[];
  apps: ProvidedApp[];
  endpoints: ProvidedEndpoint[];
  dtos: Dto[];
  clients: ConsumedHttp[];
  provides: ProvidedPackage[];
  uses: ConsumedPackage[];
  "build-files": BuildFile[];
}

/** The card's facts sorted into its sections; a repo without a commit has no card, only its tags. */
export function cardFacts(card: RepoCard | null, tags: readonly RepoTag[]): CardFacts {
  const provides = card?.provides ?? [];
  const consumes = card?.consumes ?? [];
  return {
    tags,
    mechanisms: card?.mechanisms ?? [],
    tools: card?.tools ?? [],
    apps: provides.filter((p) => p.kind === "app"),
    endpoints: provides.filter((p) => p.kind === "endpoint"),
    dtos: card?.dtos ?? [],
    clients: consumes.filter((c) => c.kind === "http"),
    provides: provides.filter((p) => p.kind === "package"),
    uses: consumes.filter((c) => c.kind === "package"),
    "build-files": card?.buildFiles ?? [],
  };
}

/**
 * The sections with facts, and the kinds without any, both in the card's order. A repo without a commit has no card to
 * miss anything from, so only its tags can be missing.
 */
export function cardSections(facts: CardFacts, hasCard: boolean): { found: CardSectionId[]; missing: CardSectionId[] } {
  const found = SECTION_IDS.filter((id) => facts[id].length > 0);
  const missing = SECTION_IDS.filter((id) => facts[id].length === 0 && (hasCard || id === "tags"));
  return { found, missing };
}
