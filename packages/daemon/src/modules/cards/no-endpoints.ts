import type { CardProblem, Consumed, ConsumedPackage, Provided } from "@trackwall/protocol";

/**
 * The `no-endpoints` card problem (ADR-116): a repo that uses a Spring web server, but on whose card the extractors found
 * no endpoint. Then the graph has nothing to point HTTP calls at, and the agent should not read the empty list as "this
 * app serves nothing": the controllers may come from a library, be written in a way the card does not read (JAX-RS,
 * `RouterFunction`), or the app may only serve the framework's own endpoints. Apps whose endpoints the framework makes
 * (a gateway, a Config Server, a Eureka or Spring Boot Admin server) do not get it.
 */

/** A dependency that makes the repo a Spring web app. */
const WEB_SERVER = /^org\.springframework(\.boot:spring-boot-starter-web(flux)?|:spring-webmvc)$/;
/** A dependency whose app serves endpoints the framework makes, not the repo's code. */
const FRAMEWORK_ENDPOINTS =
  /^(org\.springframework\.cloud:(spring-cloud-starter-gateway.*|spring-cloud-config-server|spring-cloud-starter-netflix-eureka-server)|de\.codecentric:spring-boot-admin-starter-server)$/;

export function noEndpointsProblems(provides: readonly Provided[], consumes: readonly Consumed[]): CardProblem[] {
  if (provides.some((p) => p.kind === "endpoint")) return [];
  const packages = consumes.filter((c): c is ConsumedPackage => c.kind === "package" && c.ecosystem === "maven" && !isTestScope(c));
  if (packages.some((p) => FRAMEWORK_ENDPOINTS.test(p.name))) return [];
  const web = packages.find((p) => WEB_SERVER.test(p.name));
  if (web === undefined) return [];
  return [
    {
      code: "no-endpoints",
      path: web.evidence.path,
      message: `uses ${web.name}, but the card found no endpoint: controllers from a library, JAX-RS or RouterFunction are not read`,
    },
  ];
}

/** Maven `test`, Gradle `testImplementation`, `testRuntimeOnly`…: a test dependency does not make the app a web app. */
function isTestScope(pkg: ConsumedPackage): boolean {
  return /^test/i.test(pkg.scope);
}
