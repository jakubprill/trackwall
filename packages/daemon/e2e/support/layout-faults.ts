/**
 * Finds faults of layout a person sees at a glance and a unit test cannot (ADR-260). Each fault is one line saying what
 * and by how much. Runs in the page, over the elements inside `scope` (a CSS selector) or the whole page.
 *
 * - Out of its frame: the text crosses the left or right border of a box with a visible side border (a button, a card,
 *   a strip). Text a clipping box cuts off on purpose counts only by the part that shows, and a popup (a tooltip, a
 *   menu) is its own frame, so neither is reported.
 * - Cut off: a box that clips (overflow other than visible) cuts the text on the left or right, and the box does not
 *   end it with an ellipsis (`truncate`); a box that scrolls only because its content is too wide counts too, since its
 *   text runs out of sight, unlike a box made to scroll sideways (`overflow-x-auto`).
 * - Over other text: the shown parts of two texts, or of a text and an icon, overlap by more than a hair, unless one
 *   lies in a box placed over the other with its own background on purpose (a badge on an icon, a tooltip).
 * - Painted over: at the middle of a mark (a text, an icon, a group's stripe), something with a background or an image
 *   is drawn on top of it.
 * - Empty columns: a row of a table spans more columns than the table's head names, so the table adds columns with
 *   nothing in them, which squeeze the named ones (a `colSpan` that counts a column a container query hides, say).
 * - Squeezed shut: a box made to scroll up and down holds text but is lower than one line of it, so its list looks
 *   empty (a list in a column that takes only the height the sections above it leave over, say).
 *
 * Left out: text inside a terminal, an SVG, a canvas or Home's 3D scene (`data-scene`, whose labels follow the camera),
 * and anything hidden on purpose (opacity 0, `visibility: hidden`, a closed `<details>`, a clip such as `sr-only`).
 */
export function layoutFaults(scope: string | null): string[] {
  // Playwright sends this function to the page as its source, so its helpers live inside it.
  type Shown = { node: Text; parent: Element; text: string; lines: DOMRect[] };
  type Box = { name: string; owner: Element; layer: Element | null; line: DOMRect };
  const SKIPPED = ".xterm, svg, canvas, script, style, [data-scene]";
  /** Less than this many pixels is a rounding of the layout, not a fault. */
  const HAIR = 1;
  const root = scope === null ? document.body : document.querySelector(scope);
  if (root === null) return [`nothing matches ${scope}`];
  const found: string[] = [];
  const texts = shownTexts(root);
  const icons = [...root.querySelectorAll("svg")].filter(
    (svg) => svg.closest(".xterm, [data-scene]") === null && svg.parentElement?.closest("svg") == null && !hiddenOnPurpose(svg),
  );
  textOverText(texts, icons);
  paintedOver(texts, icons, [...root.querySelectorAll("[data-group-stripe]")]);
  emptyColumns(root);
  squeezedShut(root);
  return found;

  function shownTexts(within: Element): Shown[] {
    const shown: Shown[] = [];
    const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const parent = node.parentElement;
      if (text === "" || parent === null || parent.closest(SKIPPED) !== null || hiddenOnPurpose(parent)) continue;
      const lines = [...lineBoxes(node as Text)].flatMap((line) => followOut(line, parent, text) ?? []);
      if (lines.length > 0) shown.push({ node: node as Text, parent, text, lines });
    }
    return shown;
  }

  function lineBoxes(node: Text): DOMRect[] {
    const range = document.createRange();
    range.selectNodeContents(node);
    return [...range.getClientRects()].filter((line) => line.width > 0 && line.height > 0);
  }

  /**
   * Goes out from a line of text box by box, reporting the first frame whose border the shown part crosses and every cut
   * without an ellipsis; a popup ends the search for frames, as it is a frame of its own. Returns the part still shown.
   */
  function followOut(line: DOMRect, parent: Element, text: string): DOMRect | null {
    let shown: DOMRect | null = line;
    let framed = false;
    for (let el: Element | null = parent; shown !== null && el !== null && el !== document.documentElement; el = el.parentElement) {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const by = Math.round(Math.max(box.left - shown.left, shown.right - box.right));
      const clipsX = style.overflowX !== "visible";
      if (by > HAIR && !framed && !clipsX && hasSideBorder(style)) {
        found.push(`"${text.slice(0, 60)}" runs ${by}px out of its ${el.tagName.toLowerCase()}`);
        framed = true;
      }
      if (by > HAIR && clipsX && style.textOverflow !== "ellipsis" && !scrollsSideways(el))
        found.push(`"${text.slice(0, 60)}" is cut off by ${by}px at the edge of its ${el.tagName.toLowerCase()}`);
      framed ||= style.position === "absolute" || style.position === "fixed";
      shown = clipped(shown, box, style);
    }
    return shown;
  }

  /** A box made to scroll sideways (`overflow-x-auto`, a wide board or table), whose text the user scrolls to. */
  function scrollsSideways(el: Element): boolean {
    return el.classList.contains("overflow-x-auto") || el.classList.contains("overflow-x-scroll");
  }

  /** The part of `shown` inside `box` along the axes the box clips, or null when none is. */
  function clipped(shown: DOMRect, box: DOMRect, style: CSSStyleDeclaration): DOMRect | null {
    const x = style.overflowX !== "visible";
    const y = style.overflowY !== "visible";
    const left = x ? Math.max(shown.left, box.left) : shown.left;
    const right = x ? Math.min(shown.right, box.right) : shown.right;
    const top = y ? Math.max(shown.top, box.top) : shown.top;
    const bottom = y ? Math.min(shown.bottom, box.bottom) : shown.bottom;
    return right <= left || bottom <= top ? null : new DOMRect(left, top, right - left, bottom - top);
  }

  /** Two texts, or a text and an icon, in the same layer whose shown parts overlap by more than a hair both ways. */
  function textOverText(shown: Shown[], svgs: SVGSVGElement[]): void {
    const boxes: Box[] = [
      ...shown.flatMap((t) => t.lines.map((line) => ({ name: `"${t.text.slice(0, 40)}"`, owner: t.parent, layer: layer(t.parent), line }))),
      ...svgs.map((svg) => ({ name: iconName(svg), owner: svg, layer: layer(svg), line: svg.getBoundingClientRect() })),
    ];
    boxes.forEach((a, i) => {
      for (const b of boxes.slice(i + 1)) {
        const overlap = overlapOf(a, b);
        if (overlap !== null) found.push(`${a.name} and ${b.name} overlap by ${overlap}`);
      }
    });
  }

  function overlapOf(a: Box, b: Box): string | null {
    if (a.owner === b.owner || a.layer !== b.layer) return null;
    const x = Math.min(a.line.right, b.line.right) - Math.max(a.line.left, b.line.left);
    const y = Math.min(a.line.bottom, b.line.bottom) - Math.max(a.line.top, b.line.top);
    return x > 2 * HAIR && y > 2 * HAIR ? `${Math.round(x)}×${Math.round(y)}px` : null;
  }

  /**
   * The layer an element is drawn in: the nearest box around it placed over the rest (absolute or fixed) with its own
   * background, such as a badge on an icon or a tooltip, which lies over what is under it on purpose; `null` for the page.
   */
  function layer(el: Element): Element | null {
    for (let at: Element | null = el; at !== null; at = at.parentElement) {
      const style = getComputedStyle(at);
      if ((style.position === "absolute" || style.position === "fixed") && paints(style)) return at;
    }
    return null;
  }

  /** A mark with something painted over its middle: an element above it in the page with a background or an image. */
  function paintedOver(shown: Shown[], svgs: SVGSVGElement[], stripes: Element[]): void {
    // Hit testing skips elements that let clicks through, which a mark often does: look at every element for now.
    const allHits = document.createElement("style");
    allHits.textContent = "* { pointer-events: auto !important; }";
    document.head.append(allHits);
    try {
      const marks = [
        ...shown.map((t) => ({ name: `"${t.text.slice(0, 40)}"`, el: t.parent, box: () => shownFirstLine(t.node, t.parent) })),
        ...[...svgs, ...stripes].map((el) => ({ name: iconName(el), el, box: () => el.getBoundingClientRect() })),
      ];
      for (const mark of marks) {
        const over = paintedAbove(mark.el, inView(mark.el, mark.box));
        if (over !== null) found.push(`${mark.name} is under a ${describe(over)}`);
      }
    } finally {
      allHits.remove();
    }
  }

  /** The rows that span more columns than their table's head names, in the tables shown that have a head. */
  function emptyColumns(within: Element): void {
    for (const table of within.querySelectorAll("table")) {
      const head = table.querySelector(":scope > thead > tr");
      if (head === null || hiddenOnPurpose(table)) continue;
      const named = columnsOf(head);
      for (const row of table.querySelectorAll(":scope > tbody > tr")) {
        const spans = columnsOf(row);
        if (spans > named) found.push(`${describe(row)} spans ${spans} columns of a table whose head names ${named}`);
      }
    }
  }

  /** The columns a row takes: each cell it shows, by its `colSpan`; none when the row is not shown. */
  function columnsOf(row: Element): number {
    if (getComputedStyle(row).display === "none") return 0;
    return [...row.children]
      .filter((cell) => getComputedStyle(cell).display !== "none")
      .reduce((sum, cell) => sum + (cell instanceof HTMLTableCellElement ? cell.colSpan : 1), 0);
  }

  /** The boxes made to scroll up and down that hold more text than they show and are lower than one line of it. */
  function squeezedShut(within: Element): void {
    for (const box of within.querySelectorAll("*")) {
      const style = getComputedStyle(box);
      if (scrollsTextUpAndDown(box, style) && box.clientHeight < lineHeight(style))
        found.push(`${describe(box)} is ${box.clientHeight}px high, less than a line of its text`);
    }
  }

  /** A box made to scroll up and down, shown, that holds text it does not show whole; a text field is not one. */
  function scrollsTextUpAndDown(box: Element, style: CSSStyleDeclaration): boolean {
    const scrolls = style.overflowY === "auto" || style.overflowY === "scroll";
    if (!scrolls || box.closest(`${SKIPPED}, textarea, input, select`) !== null || hiddenOnPurpose(box)) return false;
    return (box.textContent ?? "").trim() !== "" && box.scrollHeight > box.clientHeight;
  }

  /** The height of a line of the box's text; `normal` is about one and a half times the font's size. */
  function lineHeight(style: CSSStyleDeclaration): number {
    return Number.parseFloat(style.lineHeight) || 1.5 * Number.parseFloat(style.fontSize);
  }

  /** The element painted over `mark` at `at`: the first one above it with a background or an image, if any. */
  function paintedAbove(mark: Element, at: DOMPoint | null): Element | null {
    if (at === null) return null;
    for (const el of document.elementsFromPoint(at.x, at.y)) {
      // The mark itself, or the box it sits in: nothing is over it at this point.
      if (el === mark || mark.contains(el) || el.contains(mark)) return null;
      if (hiddenOnPurpose(el)) continue;
      if (paints(getComputedStyle(el)) || el instanceof HTMLImageElement || el instanceof HTMLCanvasElement) return el;
    }
    return null;
  }

  /** The middle of a mark, scrolled into the window first when it is out of it: hit testing sees only the window. */
  function inView(el: Element, box: () => DOMRect | undefined): DOMPoint | null {
    const at = middle(box());
    if (at === null || (at.x >= 0 && at.y >= 0 && at.x < window.innerWidth && at.y < window.innerHeight)) return at;
    el.scrollIntoView({ block: "center", inline: "center" });
    return middle(box());
  }

  /** The part of the text's first line that shows, where it is now. */
  function shownFirstLine(node: Text, parent: Element): DOMRect | undefined {
    let shown: DOMRect | null = lineBoxes(node)[0] ?? null;
    for (let el: Element | null = parent; shown !== null && el !== null; el = el.parentElement)
      shown = clipped(shown, el.getBoundingClientRect(), getComputedStyle(el));
    return shown ?? undefined;
  }

  function middle(rect: DOMRect | undefined): DOMPoint | null {
    if (rect === undefined || rect.width === 0 || rect.height === 0) return null;
    return new DOMPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function paints(style: CSSStyleDeclaration): boolean {
    return visibleColour(style.backgroundColor) || style.backgroundImage !== "none";
  }

  /** Hidden on purpose: invisible (also in a closed `<details>`), or clipped away like `sr-only`, here or in a box around it. */
  function hiddenOnPurpose(el: Element): boolean {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) return true;
    for (let at: Element | null = el; at !== null; at = at.parentElement) {
      const style = getComputedStyle(at);
      if ((style.clip !== "auto" && style.clip !== "") || style.clipPath !== "none") return true;
    }
    return false;
  }

  function hasSideBorder(style: CSSStyleDeclaration): boolean {
    const visible = (width: string, kind: string, color: string) => Number.parseFloat(width) > 0 && kind !== "none" && visibleColour(color);
    return (
      visible(style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor) ||
      visible(style.borderRightWidth, style.borderRightStyle, style.borderRightColor)
    );
  }

  /** Not fully transparent: `transparent`, `rgba(…, 0)` and `oklch(… / 0)` paint nothing. */
  function visibleColour(color: string): boolean {
    return color !== "transparent" && !/,\s*0\)$/.test(color) && !/\/\s*0\)$/.test(color);
  }

  function iconName(el: Element): string {
    if (el.hasAttribute("data-group-stripe")) return "the group's stripe";
    return `the icon ${el.getAttribute("aria-label") ?? [...el.classList].find((c) => c.startsWith("lucide-")) ?? el.tagName.toLowerCase()}`;
  }

  function describe(el: Element): string {
    const text = (el.textContent ?? "").trim().slice(0, 30);
    return `${el.tagName.toLowerCase()}${text === "" ? "" : ` "${text}"`}`;
  }
}

/**
 * The UI takes the system's font (Segoe UI on Windows, SF on macOS), whose words run wider than the fallback font of
 * the test browser; this letter spacing stands in for the widest of them, with a margin. The gallery of view states
 * draws its "wider font" frames with the same spacing (`packages/ui/src/gallery/gallery.css`).
 */
export const WIDER_FONT = "body { letter-spacing: 0.08em; }";
