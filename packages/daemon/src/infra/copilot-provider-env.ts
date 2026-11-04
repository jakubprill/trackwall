/**
 * The variables Copilot CLI takes a custom model provider from (`copilot help environment`, ADR-136), in one place for
 * the doctor's check (ADR-179), the provider's model list and format probes (ADR-194, ADR-197) and a session's start,
 * which sets the format per session.
 */
export const COPILOT_PROVIDER_ENV = {
  baseUrl: "COPILOT_PROVIDER_BASE_URL",
  type: "COPILOT_PROVIDER_TYPE",
  bearerToken: "COPILOT_PROVIDER_BEARER_TOKEN",
  apiKey: "COPILOT_PROVIDER_API_KEY",
  apiKeyCommand: "COPILOT_PROVIDER_API_KEY_COMMAND",
  headers: "COPILOT_PROVIDER_HEADERS",
  wireApi: "COPILOT_PROVIDER_WIRE_API",
  transport: "COPILOT_PROVIDER_TRANSPORT",
  /** The model a session runs on without `--model`. */
  model: "COPILOT_MODEL",
} as const;
