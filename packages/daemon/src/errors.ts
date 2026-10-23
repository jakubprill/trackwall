import type { ErrorCode } from "@pitwall/protocol";

/**
 * Błąd, który moduł zgłasza świadomie i który transport ma pokazać klientowi z kodem i treścią.
 * Każdy inny wyjątek API zamienia na `internal` bez szczegółów.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
