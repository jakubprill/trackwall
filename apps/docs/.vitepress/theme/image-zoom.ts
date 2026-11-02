// A click on a screenshot opens it as large as the window allows, and a click, Escape or a scroll closes it
// (medium-zoom). The screenshots are whole windows of the app, too small to read in the text column.
import mediumZoom, { type Zoom } from "medium-zoom";
import { useRoute } from "vitepress";
import { nextTick, onMounted, watch } from "vue";

/** The images of a page that zoom: all in its text, except an image that is a link, whose click must follow the link. */
const ZOOMABLE_IMAGES = ".vp-doc img:not(a img)";

/** Called from the theme's setup: attaches the zoom to the images of every page the reader opens. */
export function useImageZoom(): void {
  const route = useRoute();
  // medium-zoom builds its overlay in the document, so only in the browser, after the first page has mounted.
  let zoom: Zoom | undefined;
  const attachToPage = () => {
    zoom ??= mediumZoom({ background: "var(--vp-c-bg)", margin: 24 });
    zoom.detach();
    zoom.attach(ZOOMABLE_IMAGES);
  };
  onMounted(attachToPage);
  // VitePress swaps the page without reloading; the new page's images exist once Vue has rendered it.
  watch(
    () => route.path,
    () => nextTick(attachToPage),
  );
}
