/**
 * Rozwijanie `${klucz}` i `${klucz:domyślna}` tak jak Spring (§4.6, ADR-30): wartość z widoku konfiguracji profilu,
 * a bez niej domyślna po dwukropku (także zagnieżdżona, `${a:${b:c}}`). Klucz, którego nie ma i który nie ma domyślnej
 * (zwykle zmienna środowiskowa, `${ORDERS_URL}`), zostaje w tekście. Wartości są z repo (§8): głębokość i długość
 * wyniku są ograniczone, a każdy klucz liczy się raz na rozwinięcie.
 */

const MAX_DEPTH = 10;
const MAX_LENGTH = 4096;

/** Wpis konfiguracji, z którego pochodzi wartość: dowód rozwiniętego tekstu. */
export interface PlaceholderSource {
  value: string;
  path: string;
  line: number;
}

export interface Resolved {
  value: string;
  /** Pierwszy wpis konfiguracji, z którego wzięto wartość; `undefined`, gdy tekst nie miał rozwiniętego klucza. */
  source: PlaceholderSource | undefined;
}

export function resolvePlaceholders(text: string, get: (key: string) => PlaceholderSource | undefined): Resolved {
  return new Resolver(get).resolve(text, 0);
}

class Resolver {
  private readonly get: (key: string) => PlaceholderSource | undefined;
  private readonly memo = new Map<string, Resolved | undefined>();

  constructor(get: (key: string) => PlaceholderSource | undefined) {
    this.get = get;
  }

  resolve(text: string, depth: number): Resolved {
    if (text.length > MAX_LENGTH || !text.includes("${")) return { value: text, source: undefined };
    let value = "";
    let source: PlaceholderSource | undefined;
    for (let i = 0; i < text.length; ) {
      const start = text.indexOf("${", i);
      const end = start < 0 ? -1 : closingBrace(text, start + 2);
      if (end < 0) {
        value += text.slice(i);
        break;
      }
      const part = this.placeholder(text.slice(start + 2, end), depth) ?? { value: text.slice(start, end + 1), source: undefined };
      value += text.slice(i, start) + part.value;
      source ??= part.source;
      if (value.length > MAX_LENGTH) return { value: text, source: undefined };
      i = end + 1;
    }
    return { value, source };
  }

  /** Jeden `${…}` bez nawiasów; `undefined`, gdy klucza nie ma i nie ma domyślnej. */
  private placeholder(inner: string, depth: number): Resolved | undefined {
    const colon = topLevelColon(inner);
    const key = colon < 0 ? inner : inner.slice(0, colon);
    const fromKey = depth < MAX_DEPTH ? this.key(key, depth) : undefined;
    if (fromKey) return fromKey;
    return colon < 0 ? undefined : this.resolve(inner.slice(colon + 1), depth + 1);
  }

  private key(key: string, depth: number): Resolved | undefined {
    if (this.memo.has(key)) return this.memo.get(key);
    const entry = this.get(key);
    // Na czas liczenia klucz jest „brakiem”: cykl `a: ${a}` kończy się na nim, nie na limicie głębokości.
    this.memo.set(key, undefined);
    const resolved = entry && { value: this.resolve(entry.value, depth + 1).value, source: entry };
    this.memo.set(key, resolved);
    return resolved;
  }
}

/** Indeks `}` zamykającego `${` otwarty przed `from`; `-1`, gdy go nie ma. */
function closingBrace(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Dwukropek oddzielający domyślną, poza zagnieżdżonym `${…}`; `-1`, gdy go nie ma. */
function topLevelColon(inner: string): number {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ":" && depth === 0) return i;
  }
  return -1;
}
