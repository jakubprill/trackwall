/**
 * The smallest XML parser that `pom.xml` (the repo card, §4.6) and JUnit test reports (`test-results`, ADR-60) need:
 * elements with attributes, text and a line number, without namespaces and DTD. Comments, processing instructions
 * and `<!DOCTYPE>` are skipped, `CDATA` and entities give text. Our own, because XML libraries do not give lines,
 * and the card needs evidence with a line. Shared infrastructure, so two modules do not keep two parsers. Lenient where
 * reports need it: an attribute without quotes is skipped rather than refused.
 */

export interface XmlElement {
  name: string;
  /** The line number of the opening tag, from 1. */
  line: number;
  /** Attribute values with entities decoded; a map, so a name like `constructor` is never an inherited property. */
  attributes: ReadonlyMap<string, string>;
  children: XmlElement[];
  /** The text directly in the element, without whitespace at the edges. */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const ATTRIBUTE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The document root; throws an error with the line when the document is not valid XML within this scope. */
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
    if (this.stack.length > 0) throw new Error(`unclosed element <${this.stack.at(-1)?.name}>`);
    if (!this.root) throw new Error("no root element");
    return this.root;
  }

  /** Text up to the next `<`, then a comment, a declaration, `CDATA` or a tag. */
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
    const gt = tagEnd(this.src, lt);
    if (gt < 0) throw new Error(`unclosed tag on line ${this.lineAt(lt)}`);
    const tag = this.src.slice(lt + 1, gt);
    this.pos = gt + 1;
    if (tag.startsWith("/")) this.close(tag.slice(1).trim(), lt);
    else this.open(tag, lt);
  }

  private close(name: string, lt: number): void {
    const closed = this.stack.pop();
    if (closed?.name !== name) throw new Error(`mismatched tag </${name}> on line ${this.lineAt(lt)}`);
    closed.text = decode(closed.raw).trim();
  }

  private open(tag: string, lt: number): void {
    const name = /^[^\s/>]+/.exec(tag)?.[0];
    if (!name) throw new Error(`empty tag on line ${this.lineAt(lt)}`);
    const element: OpenElement = {
      name,
      line: this.lineAt(lt),
      attributes: attributesOf(tag.slice(name.length)),
      children: [],
      text: "",
      raw: "",
    };
    const top = this.stack.at(-1);
    if (top) top.children.push(element);
    else if (this.root) throw new Error(`second root element on line ${this.lineAt(lt)}`);
    else this.root = element;
    if (!tag.endsWith("/")) this.stack.push(element);
  }
}

/** The `>` that ends the tag at `lt`, or -1; a `>` inside a quoted attribute value (allowed unescaped in XML) does not. */
function tagEnd(src: string, lt: number): number {
  let quote: string | undefined;
  for (let i = lt + 1; i < src.length; i++) {
    const c = src[i];
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i;
  }
  return -1;
}

/** `name="value"` or `name='value'` pairs of a start tag after its name; a repeated name keeps its first value. */
function attributesOf(rest: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name, double, single] of rest.matchAll(ATTRIBUTE)) {
    if (name !== undefined && !attributes.has(name)) attributes.set(name, decode(double ?? single ?? ""));
  }
  return attributes;
}

/** Pierwsze dziecko o nazwie `name`. */
export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}

/** Children named `name` in element `path` (e.g. `children(pom, "dependencies", "dependency")`). */
export function children(el: XmlElement | undefined, container: string, name: string): XmlElement[] {
  return child(el, container)?.children.filter((c) => c.name === name) ?? [];
}

/** The text of child `name`; `undefined` when it is missing or empty. */
export function childText(el: XmlElement | undefined, name: string): string | undefined {
  return child(el, name)?.text || undefined;
}

/**
 * A comment, processing instruction, declaration or `CDATA` from position `lt`; returns the position after it, and `lt`
 * when it is a plain tag. `CDATA` content goes into the element's text without decoding entities (hence the guard marker).
 */
function skipMarkup(src: string, lt: number, top: { raw: string } | undefined): number {
  const skip = (open: string, close: string) => {
    if (!src.startsWith(open, lt)) return undefined;
    const end = src.indexOf(close, lt + open.length);
    if (end < 0) throw new Error(`unclosed ${open}`);
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

/** The line number of a position in the text; positions grow, so the counter only moves forward. */
function lineCounter(src: string): (pos: number) => number {
  let line = 1;
  let counted = 0;
  return (pos) => {
    for (; counted < pos; counted++) if (src.charCodeAt(counted) === 10) line++;
    return line;
  };
}
