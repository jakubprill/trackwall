import type { Evidence, MechanismId } from "@trackwall/protocol";

/** Wygląd karty repo w UI (ADR-25); czyste funkcje, testowane w `test/card.test.ts`. */

/** Nazwa mechanizmu dla człowieka; `Record` wymusza wpis dla każdego mechanizmu z kontraktu. */
export const MECHANISM_LABELS: Record<MechanismId, string> = {
  "spring-boot": "Spring Boot",
  feign: "Feign (OpenFeign)",
  webclient: "WebClient (WebFlux)",
  openapi: "OpenAPI",
  kafka: "Kafka",
  rabbitmq: "RabbitMQ",
  eureka: "Eureka",
  "config-server": "Spring Cloud Config Server",
  "config-client": "klient Spring Cloud Config",
  kubernetes: "Kubernetes",
  helm: "Helm",
  docker: "Docker",
  react: "React",
  angular: "Angular",
  vue: "Vue",
  svelte: "Svelte",
  express: "Express",
  nestjs: "NestJS",
};

/** Dowód jako `ścieżka:linia`, a bez linii sama ścieżka. */
export function evidenceLabel(evidence: Evidence): string {
  return evidence.line === null ? evidence.path : `${evidence.path}:${evidence.line}`;
}
