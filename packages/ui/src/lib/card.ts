import type { HttpClientVia, MechanismId } from "@trackwall/protocol";

/** Nazwy mechanizmów i rodzajów klientów HTTP z karty repo dla człowieka (ADR-25, ADR-30). */

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
  "config-client": "Spring Cloud Config client",
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

/** Skąd jest klient HTTP; `Record` wymusza wpis dla każdego rodzaju z kontraktu. */
export const HTTP_CLIENT_LABELS: Record<HttpClientVia, string> = {
  feign: "Feign",
  "http-interface": "@HttpExchange",
  webclient: "WebClient",
  "rest-client": "RestClient",
  "rest-template": "RestTemplate",
  config: "configuration",
  env: ".env",
  proxy: "proxy",
};
