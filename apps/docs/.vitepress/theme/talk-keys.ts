// On a talk page the keys a presenter's clicker or keyboard sends move one slide at a time (slides.ts), so the
// talk can be given from the site without a scroll wheel.
import { useData } from "vitepress";
import { onMounted, onUnmounted } from "vue";
import { TALK_PAGE_CLASS } from "../talk-pages.ts";
import { slideToShow } from "./slides.ts";

/** A slide of a talk page: a `<section class="slide">` in its Markdown. */
const SLIDE = ".vp-doc section.slide";

const NEXT_KEYS = ["ArrowDown", "ArrowRight", "PageDown", "j"];
const PREVIOUS_KEYS = ["ArrowUp", "ArrowLeft", "PageUp", "k"];

/** The direction a key moves in, or undefined when the key is not one of the talk's. */
function direction(event: KeyboardEvent): 1 | -1 | undefined {
  if (event.key === " ") return event.shiftKey ? -1 : 1;
  if (NEXT_KEYS.includes(event.key)) return 1;
  if (PREVIOUS_KEYS.includes(event.key)) return -1;
  return undefined;
}

/** Whether the key goes to something the reader types into, such as the search box, rather than to the page. */
function isTyping(event: KeyboardEvent): boolean {
  const target = event.target;
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

/** Called from the theme's setup: listens to the keyboard on every page and acts only on a talk page. */
export function useTalkKeys(): void {
  const { frontmatter } = useData();
  const onKey = (event: KeyboardEvent) => {
    if (frontmatter.value.pageClass !== TALK_PAGE_CLASS) return;
    if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event)) return;
    const step = direction(event);
    if (step === undefined) return;
    const slides = Array.from(document.querySelectorAll<HTMLElement>(SLIDE));
    // A slide's scroll-margin-top keeps it below VitePress's top bar; count from where it scrolls to.
    const tops = slides.map(
      (slide) => slide.getBoundingClientRect().top + window.scrollY - Number.parseFloat(getComputedStyle(slide).scrollMarginTop),
    );
    const index = slideToShow(tops, window.scrollY, step);
    if (index === undefined) return;
    event.preventDefault();
    slides[index]?.scrollIntoView({ block: "start" });
  };
  onMounted(() => window.addEventListener("keydown", onKey));
  onUnmounted(() => window.removeEventListener("keydown", onKey));
}
