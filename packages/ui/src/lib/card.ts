import type { HttpClientVia, MechanismId } from "@trackwall/protocol";

/** Human names of mechanisms and HTTP client kinds from the repo card (ADR-25, ADR-30). */

/** A mechanism's human name; `Record` forces an entry for every mechanism in the contract. */
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

/** Where an HTTP client comes from; `Record` forces an entry for every kind in the contract. */
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
