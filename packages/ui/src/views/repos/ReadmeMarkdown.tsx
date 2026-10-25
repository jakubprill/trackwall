import { createMermaidPlugin } from "@streamdown/mermaid";
import { ExternalLink, workspaceApi } from "@trackwall/protocol";
import { ImageOff } from "lucide-react";
import { type ComponentProps, type MouseEvent, useState } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Streamdown } from "streamdown";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";

/**
 * The README as formatted Markdown (ADR-35): ready-made Streamdown (GFM, raw HTML through sanitization, Mermaid diagrams
 * in `strict` mode). Loaded lazily, because Mermaid weighs a few MB. Content from the repo is untrusted, so nothing in it
 * navigates the window: the container catches every click on a link, also in a diagram's SVG, the daemon opens a web page
 * address in the system browser, and the rest is text. Images are replaced by their description.
 */
const plugins = { mermaid: createMermaidPlugin({ config: { theme: "dark" } }) };
/**
 * Our own plugins instead of Streamdown's defaults: sanitization with GitHub's schema with the `user-content-` prefix for
 * `id` and `name` (Streamdown strips it, and a README could then overwrite named elements of the window) and without
 * `rehype-harden`, which without a base URL turns relative links and images into "[blocked]". `metastring` is the code
 * block options Streamdown carries over from the fence (for example `startLine=10`).
 */
const schema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, code: [...(defaultSchema.attributes?.code ?? []), "metastring"] },
};
const rehypePlugins: ComponentProps<typeof Streamdown>["rehypePlugins"] = [rehypeRaw, [rehypeSanitize, schema]];
const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
};
const components = { a: Link, img: Image };
const mermaid = { errorComponent: MermaidError };
/** The middle mouse button: the browser would open the link in a new WebView window instead of the system browser. */
const MIDDLE_BUTTON = 1;

export function ReadmeMarkdown({ conn, text }: { conn: Connection; text: string }) {
  const [linkError, setLinkError] = useState<string>();
  const followLink = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = e.target instanceof Element ? e.target.closest("a") : null;
    if (!anchor) return;
    e.preventDefault();
    if (e.type === "auxclick" && e.button !== MIDDLE_BUTTON) return;
    // A link from a Mermaid diagram is an `<a>` in SVG, often with `xlink:href`.
    const url = ExternalLink.safeParse(anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href"));
    if (!url.success) return;
    setLinkError(undefined);
    post(conn, workspaceApi.openLink, { url: url.data }).catch((err: unknown) => setLinkError(errorMessage(err)));
  };

  return (
    <div className="flex flex-col gap-3 p-4 text-sm leading-relaxed" onClickCapture={followLink} onAuxClickCapture={followLink}>
      {linkError && <p className="text-destructive text-xs">Could not open the link: {linkError}</p>}
      <Streamdown
        mode="static"
        plugins={plugins}
        rehypePlugins={rehypePlugins}
        controls={controls}
        mermaid={mermaid}
        components={components}
      >
        {text}
      </Streamdown>
    </div>
  );
}

/** A link to a web page looks like a link; a relative one, an anchor and other protocols stay text with the address in a tooltip. */
function Link({ href, children }: ComponentProps<"a">) {
  const url = ExternalLink.safeParse(href);
  if (!url.success) return <span title={href}>{children}</span>;
  return (
    <a href={url.data} title={url.data} className="text-primary underline-offset-4 hover:underline">
      {children}
    </a>
  );
}

function Image({ alt, src }: ComponentProps<"img">) {
  return (
    <span
      className="text-muted-foreground inline-flex items-center gap-1 rounded-sm border px-1.5 align-middle text-xs"
      title={String(src ?? "")}
    >
      <ImageOff className="size-3" aria-hidden />
      {alt || "image"}
    </span>
  );
}

function MermaidError({ chart, error }: { chart: string; error: string }) {
  return (
    <div className="surface flex flex-col gap-2 p-3">
      <p className="text-destructive font-mono text-xs">Mermaid diagram error: {error}</p>
      <pre className="text-muted-foreground overflow-x-auto font-mono text-xs">{chart}</pre>
    </div>
  );
}
