/** Przebieg w tle w UI (ADR-21, ADR-27): czysta reguła dla `useBackgroundRun`; testy w `test/background-run.test.ts`. */

/**
 * Co pokazać: wynik akcji jest nowszy od każdej odpowiedzi na pytanie wysłane przed nią (także takie, które było
 * w drodze), a ustępuje pierwszej odpowiedzi na pytanie wysłane po niej, także `null` (daemon uruchomiony od nowa
 * nie zna przebiegu), żeby nie wisiał na ekranie bez końca.
 */
export function currentRun<R>(
  acted: { run: R | null; afterLoad: number } | undefined,
  remote: { data?: R | null; loadNumber?: number },
): R | null | undefined {
  if (acted && actionIsNewer(acted.afterLoad, remote.loadNumber)) return acted.run;
  return remote.data;
}

/**
 * Akcja wykonana, gdy wysłano już `afterLoad` pytań, jest nowsza od danych z pytania `loadNumber`: odpowiedź na
 * pytanie wysłane przed nią (także takie, które było w drodze) jeszcze jej nie widzi.
 */
export function actionIsNewer(afterLoad: number, loadNumber: number | undefined): boolean {
  return (loadNumber ?? 0) <= afterLoad;
}
