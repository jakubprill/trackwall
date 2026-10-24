import {
  type Evidence,
  evidenceLabel,
  type MechanismId,
  NO_MISE_TAG,
  type RepoCard,
  type RepoTag,
  type RepoTagRules,
} from "@trackwall/protocol";
import { globMatcher } from "./glob.ts";
import { dirOf } from "./repo-path.ts";

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
  const packages = card.provides.filter((p) => p.kind === "package");
  const mechanism = (ids: MechanismId[]) => card.mechanisms.find((m) => ids.includes(m.id));
  const jvm = card.buildFiles.find((f) => f.tool === "maven" || f.tool === "gradle");
  if (jvm) tags.push(["java", `build file ${jvm.path}`]);
  const typescript = card.consumes.find((c) => c.kind === "package" && c.ecosystem === "npm" && c.name === "typescript");
  if (typescript) tags.push(["typescript", `typescript dependency in ${where(typescript.evidence)}`]);
  const frontend = mechanism(FRONTEND);
  if (frontend) tags.push(["frontend", `${frontend.id} in ${where(frontend.evidence[0])}`]);
  const backend = mechanism(BACKEND);
  if (backend) tags.push(["backend", `${backend.id} in ${where(backend.evidence[0])}`]);
  const bff = bffName(card, repo);
  if (bff) tags.push(["bff", `“bff” in the name ${bff}`]);
  if (packages.length > 0 && !frontend && !backend && !mechanism(DEPLOYMENT))
    tags.push(["library", `provides ${packages[0]?.name} and has no app framework or deployment files`]);
  const monorepo = monorepoReason(card);
  if (monorepo) tags.push(["monorepo", monorepo]);
  const noMise = noMiseReason(card);
  if (noMise) tags.push([NO_MISE_TAG, noMise]);
  return tags;
}

/**
 * `no-mise`: repo bez tasków mise w commicie (ADR-34), więc ani komenda zbiorcza, ani zakładka „mise tasks” nie mają
 * czego w nim uruchomić. Tag negatywny, bo to repo trzeba znaleźć filtrem, żeby dopisać mu `mise.toml`.
 */
function noMiseReason(card: RepoCard): string | undefined {
  if (card.mise.tasks.length > 0) return undefined;
  const [config] = card.mise.configFiles;
  return config ? `${config} declares no tasks` : "no mise config in the repo root";
}

function bffName(card: RepoCard, repo: TaggedRepo): string | undefined {
  const names = [repo.id, repo.remote ?? "", ...card.provides.flatMap((p) => (p.kind === "package" || p.kind === "app" ? [p.name] : []))];
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
  if (aggregator) return `${aggregator[0]} lists ${aggregator[1]} modules or packages`;
  const rootDirs = new Set(card.buildFiles.filter((f) => !f.memberOf).map((f) => dirOf(f.path)));
  if (rootDirs.size >= 2) return `separate builds in directories ${[...rootDirs].map((d) => d || ".").join(", ")}`;
  return undefined;
}

/** Tagi z reguł `repoTags`: wzorzec pasujący do identyfikatora albo adresu repo zdalnego, bez wielkości liter. */
function ruleTags(repo: TaggedRepo, rules: RepoTagRules): [string, string][] {
  const tags: [string, string][] = [];
  for (const [name, patterns] of Object.entries(rules)) {
    const pattern = patterns.find((p) => {
      const match = globMatcher(p, { ignoreCase: true });
      return match(repo.id) || (repo.remote !== null && match(repo.remote));
    });
    if (pattern) tags.push([name, `repoTags rule in workspace.yaml: ${pattern}`]);
  }
  return tags;
}

function where(evidence: Evidence | undefined): string {
  return evidence ? evidenceLabel(evidence) : "repo";
}
