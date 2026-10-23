/**
 * Linie skryptu Gradle bez komentarzy (§4.6): mały skaner, który pomija napisy, bo `exclude("META-INF/*.SF")` nie
 * zaczyna komentarza, i przenosi komentarz blokowy oraz napis w potrójnym cudzysłowie do następnych linii.
 */

/** Dłuższa linia to dane (wygenerowany kod, osadzony plik), nie zapis zależności; wyrażenia jej nie widzą. */
const MAX_LINE_LENGTH = 2000;

/** Stan skanera między liniami: otwarty komentarz blokowy albo napis w potrójnym cudzysłowie. */
interface ScanState {
  inBlock: boolean;
  quote: string | null;
}

/** Początek komentarza albo napisu; potrójny cudzysłów przed pojedynczym. */
const SCAN_TOKEN = /\/\*|\/\/|"""|'''|["']/g;

/**
 * Linie z numerami, bez komentarzy `//` i blokowych `/* … *\/`, które w skryptach Gradle często wyłączają zależność.
 * Napisy są pomijane przy szukaniu komentarzy, bo `exclude("META-INF/*.SF")` nie zaczyna komentarza. Linie dłuższe niż
 * `MAX_LINE_LENGTH` nie trafiają do wyniku.
 */
export function codeLines(text: string): { text: string; number: number }[] {
  const lines: { text: string; number: number }[] = [];
  const state: ScanState = { inBlock: false, quote: null };
  text.split("\n").forEach((raw, i) => {
    const line = stripComments(raw, state);
    // Zwykły napis kończy się z linią; tylko potrójny cudzysłów ją przekracza.
    if (state.quote?.length === 1) state.quote = null;
    if (line.trim() !== "" && raw.length <= MAX_LINE_LENGTH) lines.push({ text: line, number: i + 1 });
  });
  return lines;
}

/** Kawałek linii przeczytany w jednym stanie skanera i pozycja, od której czytać dalej (`-1`: koniec linii). */
interface ScanStep {
  text: string;
  next: number;
}

/** Linia bez komentarzy; `state` przenosi otwarty komentarz blokowy i napis do następnej linii. */
function stripComments(raw: string, state: ScanState): string {
  let out = "";
  for (let i = 0; i >= 0 && i < raw.length; ) {
    const step = state.inBlock ? skipBlock(raw, i, state) : state.quote !== null ? readString(raw, i, state) : readCode(raw, i, state);
    out += step.text;
    i = step.next;
  }
  return out;
}

function skipBlock(raw: string, from: number, state: ScanState): ScanStep {
  const end = raw.indexOf("*/", from);
  if (end < 0) return { text: "", next: -1 };
  state.inBlock = false;
  return { text: "", next: end + 2 };
}

function readString(raw: string, from: number, state: ScanState): ScanStep {
  const end = stringEnd(raw, from, state.quote ?? "");
  if (end < 0) return { text: raw.slice(from), next: -1 };
  state.quote = null;
  return { text: raw.slice(from, end), next: end };
}

/** Kod do początku komentarza (który zmienia stan) albo napisu (który zostaje w wyniku). */
function readCode(raw: string, from: number, state: ScanState): ScanStep {
  SCAN_TOKEN.lastIndex = from;
  const token = SCAN_TOKEN.exec(raw);
  if (!token) return { text: raw.slice(from), next: -1 };
  const code = raw.slice(from, token.index);
  if (token[0] === "//") return { text: code, next: -1 };
  const next = token.index + token[0].length;
  if (token[0] === "/*") {
    state.inBlock = true;
    return { text: code, next };
  }
  state.quote = token[0];
  return { text: code + token[0], next };
}

/** Indeks za cudzysłowem zamykającym napis od `from`; `-1`, gdy go nie ma w tej linii. */
function stringEnd(raw: string, from: number, quote: string): number {
  for (let j = from; j < raw.length; j++) {
    // W potrójnym cudzysłowie (surowy napis Kotlin) `\` nie jest ucieczką.
    if (raw[j] === "\\" && quote.length === 1) j++;
    else if (raw.startsWith(quote, j)) return j + quote.length;
  }
  return -1;
}
