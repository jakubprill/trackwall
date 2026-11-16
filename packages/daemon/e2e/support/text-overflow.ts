/**
 * Finds text that runs out of the frame drawn around it: a button, a card or a strip whose border the text crosses
 * on the left or right. Text a clipping box cuts off on purpose (an ellipsis, a scrolled list) counts only by the part
 * that shows, and a popup (a tooltip, a menu) is its own frame, so neither is reported. Runs in the page.
 */
export function textOutsideFrames(): string[] {
  type Crossed = { frame: string; by: number };
  // Playwright sends this function to the page as its source, so its helpers live inside it.
  const found: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? "").trim();
    const parent = node.parentElement;
    if (text === "" || parent === null || parent.closest(".xterm, svg, canvas, script, style") !== null) continue;
    const crossed = crossedFrame(node, parent);
    if (crossed !== null) found.push(`"${text.slice(0, 60)}" runs ${crossed.by}px out of its ${crossed.frame}`);
  }
  return found;

  /** The first frame around the text whose border the shown part of the text crosses, going outwards. */
  function crossedFrame(node: Node, parent: Element): Crossed | null {
    const range = document.createRange();
    range.selectNodeContents(node);
    let shown = range.getBoundingClientRect();
    if (shown.width === 0) return null;
    for (let el: Element | null = parent; el !== null && el !== document.body; el = el.parentElement) {
      const step = stepOut(el, shown);
      if (!(step instanceof DOMRect)) return step;
      shown = step;
    }
    return null;
  }

  /**
   * One box out from the text: the frame it crosses, null when the search ends (the text is hidden or clipped away,
   * or the box is a popup, which is its own frame), or else the part of the text still shown outside the box.
   */
  function stepOut(el: Element, shown: DOMRect): Crossed | DOMRect | null {
    const style = getComputedStyle(el);
    if (style.opacity === "0" || style.visibility === "hidden") return null;
    const box = el.getBoundingClientRect();
    const clips = style.overflowX !== "visible";
    const by = Math.round(Math.max(box.left - shown.left, shown.right - box.right));
    if (!clips && by > 1 && hasSideBorder(style)) return { frame: el.tagName.toLowerCase(), by };
    if (style.position === "absolute" || style.position === "fixed") return null;
    return clips ? clipped(shown, box) : shown;
  }

  /** The part of `shown` that shows inside the clipping `box`, or null when none does. */
  function clipped(shown: DOMRect, box: DOMRect): DOMRect | null {
    const left = Math.max(shown.left, box.left);
    const right = Math.min(shown.right, box.right);
    return right <= left ? null : new DOMRect(left, shown.top, right - left, shown.height);
  }

  function hasSideBorder(style: CSSStyleDeclaration): boolean {
    const visible = (width: string, kind: string, color: string) =>
      Number.parseFloat(width) > 0 && kind !== "none" && color !== "transparent" && !/,\s*0\)$/.test(color);
    return (
      visible(style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor) ||
      visible(style.borderRightWidth, style.borderRightStyle, style.borderRightColor)
    );
  }
}

/**
 * The UI takes the system's font (Segoe UI on Windows, SF on macOS), whose words run wider than the fallback font of
 * the test browser; this letter spacing stands in for the widest of them, with a margin.
 */
export const WIDER_FONT = "body { letter-spacing: 0.08em; }";
