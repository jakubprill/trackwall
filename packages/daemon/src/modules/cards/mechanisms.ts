import type { ConsumedPackage, Mechanism, MechanismEvidence, MechanismId } from "@trackwall/protocol";
import { baseName } from "./repo-path.ts";

/**
 * The list of mechanisms (§4.6, ADR-25): framework, communication and deployment recognised by the packages the repo
 * uses and by file names. The rules are general (Spring, npm, Kubernetes); nothing company-specific (ADR-7). A package
 * matches by `<ecosystem>:<name>`, a file by its path in the repo.
 */

interface Rule {
  id: MechanismId;
  packages?: RegExp;
  files?: RegExp;
}

const RULES: Rule[] = [
  { id: "spring-boot", packages: /^maven:org\.springframework\.boot:|^gradle-plugin:org\.springframework\.boot$/ },
  { id: "feign", packages: /^maven:(org\.springframework\.cloud:spring-cloud-starter-openfeign|io\.github\.openfeign:)/ },
  { id: "webclient", packages: /^maven:org\.springframework(\.boot:spring-boot-starter-webflux|:spring-webflux)$/ },
  {
    id: "openapi",
    packages:
      /^maven:(org\.springdoc:|org\.openapitools:|io\.swagger)|^npm:(@openapitools\/|openapi-typescript|openapi-fetch$|orval$|swagger-)|^gradle-plugin:org\.openapi\.generator$/,
    files: /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i,
  },
  {
    id: "kafka",
    packages:
      /^maven:(org\.springframework\.kafka:|org\.apache\.kafka:|org\.springframework\.cloud:spring-cloud-stream-binder-kafka)|^npm:(kafkajs|@confluentinc\/|node-rdkafka)$/,
  },
  {
    id: "rabbitmq",
    packages:
      /^maven:(org\.springframework\.boot:spring-boot-starter-amqp|org\.springframework\.amqp:|com\.rabbitmq:)|^npm:(amqplib|amqp-connection-manager)$/,
  },
  { id: "eureka", packages: /^maven:org\.springframework\.cloud:spring-cloud-starter-netflix-eureka-(client|server)$/ },
  { id: "config-server", packages: /^maven:org\.springframework\.cloud:spring-cloud-config-server$/ },
  { id: "config-client", packages: /^maven:org\.springframework\.cloud:spring-cloud-(starter-config|config-client)$/ },
  {
    id: "kubernetes",
    packages: /^maven:org\.springframework\.cloud:spring-cloud-(starter-)?kubernetes/,
    files: /(^|\/)(kustomization|skaffold)\.ya?ml$|(^|\/)(k8s|kubernetes)\/.+\.ya?ml$/,
  },
  { id: "helm", files: /(^|\/)Chart\.yaml$/ },
  {
    id: "docker",
    packages: /^maven:com\.google\.cloud\.tools:jib-maven-plugin$|^gradle-plugin:com\.google\.cloud\.tools\.jib$/,
    files: /(^|\/)(Dockerfile|Containerfile)(\.[^/]+)?$|(^|\/)(docker-)?compose(\.[^/]+)?\.ya?ml$/,
  },
  { id: "react", packages: /^npm:react$/ },
  { id: "angular", packages: /^npm:@angular\/core$/ },
  { id: "vue", packages: /^npm:vue$/ },
  { id: "svelte", packages: /^npm:svelte$/ },
  { id: "express", packages: /^npm:express$/ },
  { id: "nestjs", packages: /^npm:@nestjs\/core$/ },
];

/**
 * A longer path is neither a deployment file nor a specification; the expressions from `files` do not see it, because the
 * path comes from the repo, and `(k8s|kubernetes)/.+` on a path with thousands of repetitions of `k8s/` backtracks quadratically.
 */
const MAX_PATH_LENGTH = 1024;
/** This much evidence for a mechanism is enough to check it in the repo; the rest is visible in the card's dependencies. */
const MAX_EVIDENCE = 3;

export function detectMechanisms(consumes: readonly ConsumedPackage[], paths: readonly string[]): Mechanism[] {
  return RULES.flatMap((rule) => {
    const evidence = [...packageEvidence(rule, consumes), ...fileEvidence(rule, paths)].slice(0, MAX_EVIDENCE);
    return evidence.length > 0 ? [{ id: rule.id, evidence }] : [];
  });
}

function packageEvidence(rule: Rule, consumes: readonly ConsumedPackage[]): MechanismEvidence[] {
  const pattern = rule.packages;
  if (!pattern) return [];
  return consumes
    .filter((c) => pattern.test(`${c.ecosystem}:${c.name}`))
    .slice(0, MAX_EVIDENCE)
    .map((c) => ({ ...c.evidence, detail: c.name }));
}

function fileEvidence(rule: Rule, paths: readonly string[]): MechanismEvidence[] {
  const pattern = rule.files;
  if (!pattern) return [];
  const found: MechanismEvidence[] = [];
  for (const path of paths) {
    if (found.length >= MAX_EVIDENCE) break;
    if (path.length <= MAX_PATH_LENGTH && pattern.test(path)) found.push({ path, line: null, detail: baseName(path) });
  }
  return found;
}
