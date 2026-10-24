/**
 * Numeracja danych jednego widoku (`useRemote`): pytanie HTTP dostaje numer w chwili wysłania, migawka z WebSocketu
 * zdarzeń w chwili przyjścia (ADR-36), z jednego licznika. Na ekran trafiają tylko dane o numerze nie mniejszym niż
 * pokazane, więc odpowiedź na pytanie wysłane przed migawką nie cofa widoku do starszego stanu.
 */
export class LoadOrder {
  #issued = 0;
  #shown = 0;

  /** Numer dla pytania, które właśnie idzie, albo migawki, która właśnie przyszła. */
  next(): number {
    return ++this.#issued;
  }

  /** Ile numerów wydano do tej chwili (`sentLoads`). */
  issued(): number {
    return this.#issued;
  }

  /** Dane o tym numerze idą na ekran, gdy nie są starsze niż pokazane; wtedy to one są pokazane. */
  show(loadNumber: number): boolean {
    if (this.isOutdated(loadNumber)) return false;
    this.#shown = loadNumber;
    return true;
  }

  /** Dane albo błąd starsze niż pokazane dane nic już o nich nie mówią. */
  isOutdated(loadNumber: number): boolean {
    return loadNumber < this.#shown;
  }
}
