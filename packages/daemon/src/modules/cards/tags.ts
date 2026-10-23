import type { Evidence, MechanismId, RepoCard, RepoTag, RepoTagRules } from "@trackwall/protocol";
import { globToRegExp } from "./glob.ts";
import { dirOf } from "./snapshot.ts";

/**
 * Tagi repo (ADR-25): automatyczne z karty, każdy z powodem, oraz z reguł `repoTags` w `workspace.yaml`. Tagi
 * automatyczne są ortogonalne (język, rola, budowa repo), więc „BFF w Javie” to filtr `java` + `bff`, a nazwy
 * zespołów i grup firmy przychodzą tylko z reguł użytkownika (ADR-7).
 */

/** Repo, któremu liczymy tagi: identyfikator i adres repo zdalnego do reguł i rozpoznania `bff` z nazwy. */
export interface TaggedRepo {
  id: string;
  remote: string | null;
}

const FRONTEND: MechanismId[] = ["react", "angular", "vue", "svelte"];
const BACKEND: MechanismId[] = ["spring-boot", "express", "nestjs"];
const DEPLOYMENT: MechanismId[] = ["docker", "helm", "kubernetes"];
/** `bff` jako osobne słowo nazwy (`orders-bff`, `bff_web`), nie fragment innego słowa. */
const BFF_WORD = /(^|[^a-z0-9])bff([^a-z0-9]|$)/i;

export function repoTags(card: RepoCard | null, repo: TaggedRepo, rules: RepoTagRules): RepoTag[] {
  const tags = new Map<string, string>();
  const add = (name: string, reason: string) => {
    if (!tags.has(name)) tags.set(name, reason);
  };
  if (card) for (const [name, reason] of cardTags(card, repo)) add(name, reason);
  for (const [name, reason] of ruleTags(repo, rules)) add(name, reason);
  return [...tags].map(([name, reason]) => ({ name, reason })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function cardTags(card: RepoCard, repo: TaggedRepo): [string, string][] {
  const tags: [string, string][] = [];
  const mechanism = (ids: MechanismId[]) => card.mechanisms.find((m) => ids.includes(m.id));
  const jvm = card.buildFiles.find((f) => f.tool === "maven" || f.tool === "gradle");
  if (jvm) tags.push(["java", `plik buildu ${jvm.path}`]);
  const typescript = card.consumes.find((c) => c.ecosystem === "npm" && c.name === "typescript");
  if (typescript) tags.push(["typescript", `zależność typescript w ${where(typescript.evidence)}`]);
  const frontend = mechanism(FRONTEND);
  if (frontend) tags.push(["frontend", `${frontend.id} w ${where(frontend.evidence[0])}`]);
  const backend = mechanism(BACKEND);
  if (backend) tags.push(["backend", `${backend.id} w ${where(backend.evidence[0])}`]);
  const bff = bffName(card, repo);
  if (bff) tags.push(["bff", `„bff” w nazwie ${bff}`]);
  if (card.provides.length > 0 && !frontend && !backend && !mechanism(DEPLOYMENT))
    tags.push(["library", `udostępnia ${card.provides[0]?.name} i nie ma frameworka aplikacji ani plików wdrożenia`]);
  const monorepo = monorepoReason(card);
  if (monorepo) tags.push(["monorepo", monorepo]);
  return tags;
}

function bffName(card: RepoCard, repo: TaggedRepo): string | undefined {
  const names = [repo.id, repo.remote ?? "", ...card.provides.map((p) => p.name)];
  return names.find((name) => BFF_WORD.test(name));
}

/**
 * Monorepo: plik buildu wymienia co najmniej dwa moduły albo paczki workspace, albo repo ma co najmniej dwa
 * niezależne buildy w różnych katalogach (np. `backend/pom.xml` i `frontend/package.json`).
 */
function monorepoReason(card: RepoCard): string | undefined {
  const members = new Map<string, number>();
  for (const f of card.buildFiles) if (f.memberOf) members.set(f.memberOf, (members.get(f.memberOf) ?? 0) + 1);
  const aggregator = [...members].find(([, count]) => count >= 2);
  if (aggregator) return `${aggregator[0]} wymienia ${aggregator[1]} moduły lub paczki`;
  const rootDirs = new Set(card.buildFiles.filter((f) => !f.memberOf).map((f) => dirOf(f.path)));
  if (rootDirs.size >= 2) return `osobne buildy w katalogach ${[...rootDirs].map((d) => d || ".").join(", ")}`;
  return undefined;
}

/** Tagi z reguł `repoTags`: wzorzec pasujący do identyfikatora albo adresu repo zdalnego, bez wielkości liter. */
function ruleTags(repo: TaggedRepo, rules: RepoTagRules): [string, string][] {
  const tags: [string, string][] = [];
  for (const [name, patterns] of Object.entries(rules)) {
    const pattern = patterns.find((p) => {
      const re = globToRegExp(p, { ignoreCase: true });
      return re.test(repo.id) || (repo.remote !== null && re.test(repo.remote));
    });
    if (pattern) tags.push([name, `reguła repoTags w workspace.yaml: ${pattern}`]);
  }
  return tags;
}

function where(evidence: Evidence | undefined): string {
  if (!evidence) return "repo";
  return evidence.line === null ? evidence.path : `${evidence.path}:${evidence.line}`;
}
