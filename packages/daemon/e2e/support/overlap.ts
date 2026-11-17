/**
 * Finds things drawn over each other inside one element: two pieces of text, or a piece of text, an icon or a button
 * over another one that does not hold it. Hidden and see-through things do not count, and text cut off with an ellipsis
 * counts by the part that shows. Runs in the page; Playwright sends the function as its source, so its helpers live
 * inside it (which is also why `clipped` is not shared with `text-overflow.ts`).
 */
export function overlapsIn(root: Element): string[] {
  type Drawn = { what: string; el: Element; box: DOMRect };
  const drawn: Drawn[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = (node.textContent ?? "").trim();
    const el = node.parentElement;
    if (text === "" || el === null || !shows(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const line of range.getClientRects()) {
      const box = clipped(line, el);
      if (box !== null) drawn.push({ what: `"${text.slice(0, 40)}"`, el, box });
    }
  }
  for (const el of root.querySelectorAll("svg, button")) {
    const box = el.getBoundingClientRect();
    if (box.width > 0 && shows(el)) drawn.push({ what: el.tagName.toLowerCase(), el, box });
  }
  const found: string[] = [];
  drawn.forEach((a, i) => {
    for (const b of drawn.slice(i + 1))
      if (!a.el.contains(b.el) && !b.el.contains(a.el) && cross(a.box, b.box)) found.push(`${a.what} over ${b.what}`);
  });
  return found;

  function shows(el: Element): boolean {
    if (el.closest(".sr-only, .xterm") !== null) return false;
    for (let e: Element | null = el; e !== null; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.opacity === "0" || style.visibility === "hidden") return false;
    }
    return true;
  }

  /** The part of `box` that shows through the boxes around `el` that clip what runs out of them (an ellipsis). */
  function clipped(box: DOMRect, el: Element): DOMRect | null {
    let left = box.left;
    let right = box.right;
    for (let e: Element | null = el; e !== null && e !== root.parentElement; e = e.parentElement) {
      if (getComputedStyle(e).overflowX === "visible") continue;
      const around = e.getBoundingClientRect();
      left = Math.max(left, around.left);
      right = Math.min(right, around.right);
    }
    return right - left > 0 ? new DOMRect(left, box.top, right - left, box.height) : null;
  }

  function cross(a: DOMRect, b: DOMRect): boolean {
    const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return x > 1 && y > 1;
  }
}
