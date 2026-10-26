import {
  type Evidence,
  evidenceLabel,
  type MechanismId,
  NO_MISE_TAG,
  type RepoCard,
  type RepoTag,
  type RepoTagRules,
} from "@trackwall/protocol";
import { globMatcher } from "../../infra/glob.ts";
import { dirOf } from "./repo-path.ts";

/**
 * Repo tags (ADR-25): automatic ones from the card, each with a reason, and ones from the `repoTags` rules in
 * `workspace.yaml`. Automatic tags are orthogonal (language, role, repo structure), so "BFF in Java" is the filter
 * `java` + `bff`, and the names of a company's teams and groups come only from the user's rules (ADR-7).
 */

/** The repo we compute tags for: the identifier and the remote address, for the rules and for recognising `bff` in the name. */
export interface TaggedRepo {
  id: string;
  remote: string | null;
  /** How many mise tasks the repo's `mise.local.toml` declares in the working directory (ADR-86): the commit never has them. */
  localMiseTasks: number;
}

const FRONTEND: MechanismId[] = ["react", "angular", "vue", "svelte"];
const BACKEND: MechanismId[] = ["spring-boot", "express", "nestjs"];
const DEPLOYMENT: MechanismId[] = ["docker", "helm", "kubernetes"];
/** `bff` as a separate word of the name (`orders-bff`, `bff_web`), not part of another word. */
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
  const noMise = noMiseReason(card, repo);
  if (noMise) tags.push([NO_MISE_TAG, noMise]);
  return tags;
}

/**
 * `no-mise`: a repo without mise tasks in the commit (ADR-34) or in its `mise.local.toml` (ADR-86), so neither the `setup`
 * and `build` steps of the batch command nor the "mise tasks" tab have anything to run in it. A negative tag, because
 * such a repo has to be found with a filter to give it mise tasks.
 */
function noMiseReason(card: RepoCard, repo: TaggedRepo): string | undefined {
  if (card.mise.tasks.length > 0 || repo.localMiseTasks > 0 || !card.mise.complete) return undefined;
  const [config] = card.mise.configFiles;
  return config ? `${config} declares no tasks` : "no mise config in the repo root";
}

function bffName(card: RepoCard, repo: TaggedRepo): string | undefined {
  const names = [repo.id, repo.remote ?? "", ...card.provides.flatMap((p) => (p.kind === "package" || p.kind === "app" ? [p.name] : []))];
  return names.find((name) => BFF_WORD.test(name));
}

/**
 * Monorepo: a build file lists at least two modules or workspace packages, or the repo has at least two independent
 * builds in different directories (e.g. `backend/pom.xml` and `frontend/package.json`).
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

/** Tags from the `repoTags` rules: a pattern matching the identifier or the remote address, ignoring case. */
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
