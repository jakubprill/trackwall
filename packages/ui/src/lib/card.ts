import type { MechanismId } from "@trackwall/protocol";

/** Nazwy mechanizmów z karty repo dla człowieka (ADR-25). */

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
