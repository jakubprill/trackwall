/** Komunikat błędu dla użytkownika: wyjątek z kodu albo cokolwiek innego, co zostało rzucone. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
