/**
 * Najmniejszy parser XML, jakiego potrzebuje `pom.xml`: elementy z tekstem i numerem linii, bez atrybutów, przestrzeni
 * nazw i DTD. Komentarze, instrukcje przetwarzania i `<!DOCTYPE>` są pomijane, `CDATA` i encje dają tekst. Własny,
 * bo biblioteki XML nie podają linii, a karta potrzebuje dowodu z linią (§4.6).
 */

export interface XmlElement {
  name: string;
  /** Numer linii znacznika otwierającego, od 1. */
  line: number;
  children: XmlElement[];
  /** Tekst bezpośrednio w elemencie, bez białych znaków na brzegach. */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Korzeń dokumentu; rzuca błąd z linią, gdy dokument nie jest poprawnym XML w tym zakresie. */
export function parseXml(src: string): XmlElement {
  return new XmlParser(src).parse();
}

type OpenElement = XmlElement & { raw: string };

class XmlParser {
  private readonly src: string;
  private readonly lineAt: (pos: number) => number;
  private readonly stack: OpenElement[] = [];
  private root: XmlElement | undefined;
  private pos = 0;

  constructor(src: string) {
    this.src = src;
    this.lineAt = lineCounter(src);
  }

  parse(): XmlElement {
    while (this.pos < this.src.length) this.step();
    if (this.stack.length > 0) throw new Error(`niezamknięty element <${this.stack.at(-1)?.name}>`);
    if (!this.root) throw new Error("brak elementu głównego");
    return this.root;
  }

  /** Tekst do następnego `<`, potem komentarz, deklaracja, `CDATA` albo znacznik. */
  private step(): void {
    const lt = this.src.indexOf("<", this.pos);
    const top = this.stack.at(-1);
    if (top) top.raw += this.src.slice(this.pos, lt < 0 ? this.src.length : lt);
    if (lt < 0) {
      this.pos = this.src.length;
      return;
    }
    this.pos = skipMarkup(this.src, lt, top);
    if (this.pos === lt) this.tag(lt);
  }

  private tag(lt: number): void {
    const gt = this.src.indexOf(">", lt);
    if (gt < 0) throw new Error(`niezamknięty znacznik w linii ${this.lineAt(lt)}`);
    const tag = this.src.slice(lt + 1, gt);
    this.pos = gt + 1;
    if (tag.startsWith("/")) this.close(tag.slice(1).trim(), lt);
    else this.open(tag, lt);
  }

  private close(name: string, lt: number): void {
    const closed = this.stack.pop();
    if (closed?.name !== name) throw new Error(`niepasujący znacznik </${name}> w linii ${this.lineAt(lt)}`);
    closed.text = decode(closed.raw).trim();
  }

  private open(tag: string, lt: number): void {
    const name = /^[^\s/>]+/.exec(tag)?.[0];
    if (!name) throw new Error(`pusty znacznik w linii ${this.lineAt(lt)}`);
    const element: OpenElement = { name, line: this.lineAt(lt), children: [], text: "", raw: "" };
    const top = this.stack.at(-1);
    if (top) top.children.push(element);
    else if (this.root) throw new Error(`drugi element główny w linii ${this.lineAt(lt)}`);
    else this.root = element;
    if (!tag.endsWith("/")) this.stack.push(element);
  }
}

/** Pierwsze dziecko o nazwie `name`. */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}

/** Dzieci o nazwie `name` w elemencie `path` (np. `children(pom, "dependencies", "dependency")`). */
export function children(el: XmlElement | undefined, container: string, name: string): XmlElement[] {
  return child(el, container)?.children.filter((c) => c.name === name) ?? [];
}

/** Tekst dziecka `name`; `undefined`, gdy go nie ma albo jest pusty. */
export function childText(el: XmlElement | undefined, name: string): string | undefined {
  return child(el, name)?.text || undefined;
}

/**
 * Komentarz, instrukcja przetwarzania, deklaracja albo `CDATA` od pozycji `lt`; zwraca pozycję za nimi, a `lt`, gdy
 * to zwykły znacznik. Treść `CDATA` trafia do tekstu elementu bez dekodowania encji (stąd znacznik ochronny).
 */
function skipMarkup(src: string, lt: number, top: { raw: string } | undefined): number {
  const skip = (open: string, close: string) => {
    if (!src.startsWith(open, lt)) return undefined;
    const end = src.indexOf(close, lt + open.length);
    if (end < 0) throw new Error(`niezamknięte ${open}`);
    return end + close.length;
  };
  const cdataEnd = skip("<![CDATA[", "]]>");
  if (cdataEnd !== undefined) {
    if (top)
      top.raw += src
        .slice(lt + 9, cdataEnd - 3)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;");
    return cdataEnd;
  }
  return skip("<!--", "-->") ?? skip("<?", "?>") ?? skip("<!", ">") ?? lt;
}

function decode(raw: string): string {
  return raw.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity] ?? whole;
  });
}

/** Numer linii pozycji w tekście; pozycje rosną, więc licznik idzie tylko do przodu. */
function lineCounter(src: string): (pos: number) => number {
  let line = 1;
  let counted = 0;
  return (pos) => {
    for (; counted < pos; counted++) if (src.charCodeAt(counted) === 10) line++;
    return line;
  };
}
