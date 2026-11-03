// The talk as a deck (talk-pages.ts): one slide at a time, with buttons and the keys a presenter's clicker or
// keyboard sends to move between them, and the slide's number in the address so a reload stays on it. Without
// JavaScript the page is the slides one below another.
import { useData, useRoute } from "vitepress";
import { computed, defineComponent, h, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { TALK_PAGE_CLASS } from "../talk-pages.ts";
import { hashOfSlide, slideFromHash, stepSlide } from "./slides.ts";

/** The page's text; its `deck` class turns the slides into a deck (trackwall.css). */
const DOC = ".talk .vp-doc";
/** A slide: a `<section class="slide">` in the page's Markdown. */
const SLIDE = "section.slide";
/** A screenshot opened larger (image-zoom.ts): the keys are the zoom's until it closes. */
const OPEN_ZOOM = ".medium-zoom-overlay";

const NEXT_KEYS = ["arrowdown", "arrowright", "pagedown", "j"];
const PREVIOUS_KEYS = ["arrowup", "arrowleft", "pageup", "k"];

/** The direction a key moves in, or undefined when the key is not one of the deck's; J and K also with Shift or Caps Lock. */
function direction(event: KeyboardEvent): 1 | -1 | undefined {
  const key = event.key.toLowerCase();
  if (key === " ") return event.shiftKey ? -1 : 1;
  if (NEXT_KEYS.includes(key)) return 1;
  if (PREVIOUS_KEYS.includes(key)) return -1;
  return undefined;
}

/** Whether the key belongs to what has the focus: a field the reader types into, or a link or button Space presses. */
function isForFocused(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return event.key === " " && ["A", "BUTTON"].includes(target.tagName);
}

/** The bar under a talk's slides: previous, the slide's number of all, next; nothing on other pages. */
export const TalkDeck = defineComponent(() => {
  const { frontmatter } = useData();
  const route = useRoute();
  const isTalk = computed(() => frontmatter.value.pageClass === TALK_PAGE_CLASS);
  const slides = ref<HTMLElement[]>([]);
  const shown = ref(0);

  const show = (index: number) => {
    const doc = document.querySelector(DOC);
    for (const [i, slide] of slides.value.entries()) slide.classList.toggle("shown", i === index);
    doc?.classList.toggle("on-first", index === 0);
    shown.value = index;
    history.replaceState(history.state, "", hashOfSlide(index));
    window.scrollTo({ top: 0 });
  };
  const step = (by: 1 | -1) => show(stepSlide(shown.value, slides.value.length, by));

  // VitePress swaps the page without reloading; the slides of a new page exist once Vue has rendered it.
  const attach = () => {
    const doc = document.querySelector(DOC);
    slides.value = doc === null ? [] : Array.from(doc.querySelectorAll<HTMLElement>(SLIDE));
    if (doc === null || slides.value.length === 0) return;
    doc.classList.add("deck");
    show(slideFromHash(location.hash, slides.value.length));
  };

  const onKey = (event: KeyboardEvent) => {
    if (!isTalk.value || slides.value.length === 0) return;
    if (event.altKey || event.ctrlKey || event.metaKey || isForFocused(event)) return;
    if (document.querySelector(OPEN_ZOOM) !== null) return;
    const by = direction(event);
    if (by === undefined) return;
    event.preventDefault();
    step(by);
  };

  // A link to another slide of the same talk, or the browser's back button, changes only the hash.
  const onHash = () => {
    if (isTalk.value && slides.value.length > 0) show(slideFromHash(location.hash, slides.value.length));
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
    if (!isTalk.value || count === 0) return null;
    return h("nav", { class: "talk-deck-bar", "aria-label": "Slides" }, [
      h("button", { type: "button", "aria-label": "Previous slide", disabled: shown.value === 0, onClick: () => step(-1) }, "←"),
      h("span", { class: "talk-deck-count", "aria-live": "polite" }, `${shown.value + 1} / ${count}`),
      h("button", { type: "button", "aria-label": "Next slide", disabled: shown.value === count - 1, onClick: () => step(1) }, "→"),
    ]);
  };
});
