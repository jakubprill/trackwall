import type { ErrorCode } from "@trackwall/protocol";

/**
 * Błąd, który moduł zgłasza świadomie i który transport ma pokazać klientowi z kodem i treścią.
 * Każdy inny wyjątek API zamienia na `internal` bez szczegółów.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
