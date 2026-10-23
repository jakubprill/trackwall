import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LogSource } from "@trackwall/protocol";

/**
 * Plik JSONL jednego źródła (§4.2): `logs/<rodzaj>/<repo>/<task mise>.jsonl` w katalogu stanu, jedna linia na
 * rekord. Zapis jest buforowany i dopisywany paczkami (`flush`), żeby głośny proces nie robił zapisu na każdą linię.
 * Po przekroczeniu limitu plik staje się `<nazwa>.1.jsonl` (poprzedni `.1` znika), więc źródło zajmuje najwyżej
 * dwa limity. Nieudany zapis (np. plik trzymany przez antywirusa) zostaje w buforze do następnej próby.
 */

/** Tyle niezapisanego tekstu czeka najwyżej w pamięci, gdy zapis się nie udaje; nadmiar przepada z wpisem w logu. */
const MAX_PENDING_CHARS = 4 * 1024 * 1024;

export class LogFile {
  readonly path: string;
  private readonly maxBytes: number;
  private readonly onRotationError: (err: unknown) => void;
  /** Nieudana rotacja jest zgłaszana raz, do następnej udanej. */
  private rotationFailing = false;
  private pending: string[] = [];
  private pendingChars = 0;
  /** Rozmiar pliku na dysku; nieznany do pierwszego zapisu (plik mógł zostać po poprzednim działaniu daemona). */
  private size: number | undefined;

  constructor(path: string, maxBytes: number, onRotationError: (err: unknown) => void) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.onRotationError = onRotationError;
  }

  /** Zwraca `false`, gdy bufor jest pełny i linia przepadła. */
  append(json: string): boolean {
    if (this.pendingChars + json.length > MAX_PENDING_CHARS) return false;
    this.pending.push(`${json}\n`);
    this.pendingChars += json.length + 1;
    return true;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Dopisuje bufor do pliku; rzuca błąd systemu plików, a bufor zostaje do następnej próby. */
  flush(): void {
    if (this.pending.length === 0) return;
    const text = this.pending.join("");
    const bytes = Buffer.byteLength(text);
    mkdirSync(dirname(this.path), { recursive: true });
    this.size ??= sizeOf(this.path);
    if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
    appendFileSync(this.path, text);
    this.size += bytes;
    this.pending = [];
    this.pendingChars = 0;
  }

  /**
   * Rotacja, która się nie udała (na Windowsie plik otwarty bez `FILE_SHARE_DELETE`, np. przez `Get-Content -Wait`
   * albo antywirusa), nie wstrzymuje zapisu: plik rośnie ponad limit, a rotacja jest ponawiana przy następnym zapisie.
   */
  private rotate(): void {
    try {
      renameSync(this.path, rotatedPath(this.path));
      this.size = 0;
      this.rotationFailing = false;
    } catch (err) {
      if (!this.rotationFailing) this.onRotationError(err);
      this.rotationFailing = true;
    }
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

export function rotatedPath(path: string): string {
  return path.replace(/\.jsonl$/, ".1.jsonl");
}

/** Ścieżka pliku źródła w katalogu logów. */
export function logFilePath(dir: string, source: LogSource): string {
  return join(dir, source.kind, fileName(source.repo), `${fileName(source.miseTask)}.jsonl`);
}

/**
 * Nazwy urządzeń Windowsa; z rozszerzeniem też (`con.jsonl` to urządzenie), ale po zakodowaniu nazwa nie ma kropki,
 * więc wystarczy porównać całą.
 */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
/**
 * Dłuższa nazwa jest skracana ze skrótem: dwie takie nazwy z `logs\mise-task` i `.1.jsonl` to ok. 140 znaków, więc
 * ścieżka mieści się w limicie 260 znaków Windowsa przy katalogu stanu do ok. 100 znaków.
 */
const MAX_NAME_CHARS = 60;

/**
 * Nazwa pliku z dowolnego napisu, ta sama na Windowsie i macOS: znaki spoza `[a-z0-9_-]` (także `:` z `build:ui`,
 * `.` i wielkie litery, bo system plików macOS i Windowsa nie odróżnia `Build` od `build`) jako `%XX` bajtów UTF-8,
 * a nazwa zarezerwowana zaczyna się od `%`. Różne napisy dają różne nazwy.
 */
export function fileName(name: string): string {
  let encoded = [...Buffer.from(name, "utf8")]
    .map((b) => (/[a-z0-9_-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`))
    .join("");
  if (RESERVED.test(encoded)) encoded = `%${encoded}`;
  if (encoded.length <= MAX_NAME_CHARS) return encoded;
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `${encoded.slice(0, MAX_NAME_CHARS - hash.length - 1)}~${hash}`;
}
