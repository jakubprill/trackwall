// The talk as a deck (talk-pages.ts): one slide at a time, with buttons and the keys a presenter's clicker or
// keyboard sends to move between them (slides.ts), and the slide's number in the address so a reload stays on it.
// Without JavaScript the page is the slides one below another.
import { useData, useRoute } from "vitepress";
import { defineComponent, h, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from "vue";
import { hashOfSlide, isTypingInto, slideFromHash, slideKeyDirection, stepSlide } from "./slides.ts";

/** The text of a talk page; its `deck` class turns the slides into a deck (trackwall.css). */
const TALK_DOC = ".talk .vp-doc";
/** A slide: a `<section class="slide">` in the page's Markdown. */
const SLIDE = "section.slide";
/** A screenshot opened larger (image-zoom.ts): the keys are the zoom's until it closes. */
const OPEN_ZOOM = ".medium-zoom-overlay";

/** The bar's words; the Polish talk is a page under /pl/, not a locale with its own `lang` (ADR-142). */
const LABELS = {
  en: { bar: "Slides", previous: "Previous slide", next: "Next slide" },
  pl: { bar: "Slajdy", previous: "Poprzedni slajd", next: "Następny slajd" },
};

/** The bar under a talk's slides: previous, the slide's number of all, next; nothing on other pages. */
export const TalkDeck = defineComponent(() => {
  const { page } = useData();
  const route = useRoute();
  const doc = shallowRef<Element | null>(null);
  const slides = shallowRef<HTMLElement[]>([]);
  const shown = ref(0);

  const show = (index: number) => {
    for (const [i, slide] of slides.value.entries()) slide.classList.toggle("shown", i === index);
    doc.value?.classList.toggle("on-first", index === 0);
    shown.value = index;
    if (location.hash !== hashOfSlide(index)) history.replaceState(history.state, "", hashOfSlide(index));
    window.scrollTo({ top: 0 });
  };
  const step = (by: 1 | -1) => show(stepSlide(shown.value, slides.value.length, by));

  /** The slide the address names: by its number, or the slide holding the heading a link points at. */
  const named = (): number | undefined => {
    const byNumber = slideFromHash(location.hash, slides.value.length);
    if (byNumber !== undefined) return byNumber;
    const anchor = location.hash.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    const holder = anchor?.closest<HTMLElement>(SLIDE);
    return holder === null || holder === undefined ? undefined : slides.value.indexOf(holder);
  };

  // VitePress swaps the page without reloading, and renders a new page's classes afresh; its slides exist once Vue
  // has rendered it.
  const attach = () => {
    doc.value = document.querySelector(TALK_DOC);
    slides.value = doc.value === null ? [] : Array.from(doc.value.querySelectorAll<HTMLElement>(SLIDE));
    if (doc.value === null || slides.value.length === 0) return;
    doc.value.classList.add("deck");
    show(named() ?? 0);
  };

  const onKey = (event: KeyboardEvent) => {
    if (slides.value.length === 0 || event.altKey || event.ctrlKey || event.metaKey) return;
    if (isTypingInto(event.target instanceof HTMLElement ? event.target : null)) return;
    if (document.querySelector(OPEN_ZOOM) !== null) return;
    const by = slideKeyDirection(event.key);
    if (by === undefined) return;
    event.preventDefault();
    step(by);
  };
  // A link to another slide or heading of the same talk, or the browser's back button, changes only the hash.
  const onHash = () => {
    if (slides.value.length > 0) show(named() ?? shown.value);
  };

  onMounted(() => {
    window.addEventListener("keydown", onKey);
    window.addEventListener("hashchange", onHash);
    attach();
  });
  onUnmounted(() => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("hashchange", onHash);
  });
  watch(
    () => route.path,
    () => nextTick(attach),
  );

  return () => {
    const count = slides.value.length;
    if (count === 0) return null;
    const labels = page.value.relativePath.startsWith("pl/") ? LABELS.pl : LABELS.en;
    // aria-disabled rather than disabled, so the button a presenter clicked keeps the focus at either end.
    const button = (label: string, by: 1 | -1, atEnd: boolean, arrow: string) =>
      h("button", { type: "button", "aria-label": label, "aria-disabled": atEnd, onClick: () => atEnd || step(by) }, arrow);
    return h("nav", { class: "talk-deck-bar", "aria-label": labels.bar }, [
      button(labels.previous, -1, shown.value === 0, "←"),
      h("span", { class: "talk-deck-count", "aria-live": "polite" }, `${shown.value + 1} / ${count}`),
      button(labels.next, 1, shown.value === count - 1, "→"),
    ]);
  };
});
