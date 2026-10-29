import type { CardProblemCode, HttpClientVia, MechanismId } from "@trackwall/protocol";

/** Human names of mechanisms, HTTP client kinds and problem codes from the repo card (ADR-25, ADR-30, ADR-80). */

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
  openapi: "OpenAPI spec",
};

/** What a card problem means for the card (ADR-80); `Record` forces an entry for every code in the contract. */
export const CARD_PROBLEM_LABELS: Record<CardProblemCode, string> = {
  "files-not-read": "not read",
  "file-invalid": "invalid file",
  "parse-incomplete": "not parsed",
  truncated: "cut short",
  "no-endpoints": "no endpoints",
};
