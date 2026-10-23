import { z } from "zod";

/**
 * Schemat napisu z JSON-em: zły JSON i zły kształt dają ten sam rodzaj błędu zod. Jedno miejsce dla
 * „`JSON.parse` i schemat” na danych z zewnątrz (linie nagrania, `hooks.jsonl`, stdin hooka).
 */
export function jsonOf<T extends z.ZodType>(schema: T) {
  return z
    .string()
    .transform((text, ctx): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        ctx.addIssue({ code: "custom", message: "to nie jest poprawny JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema);
}
