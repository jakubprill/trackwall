/**
 * Wywołanie, które w trakcie trwania oddaje tę samą obietnicę każdemu następnemu wołającemu. Dla odczytu z kursorem:
 * dwa pytania naraz (StrictMode uruchamia efekt dwa razy, `reload` w trakcie odpytywania) poszłyby z tym samym
 * kursorem, a ta sama strona zostałaby doklejona dwa razy.
 */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    inFlight ??= run().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
