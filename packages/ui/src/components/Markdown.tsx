import { createMermaidPlugin } from "@streamdown/mermaid";
import { ExternalLink } from "@trackwall/protocol";
import { ImageOff } from "lucide-react";
import { type ComponentProps, type MouseEvent, useState } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { Streamdown } from "streamdown";
import { errorMessage } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useOpenWebLink } from "@/lib/desktop";
import { cn } from "@/lib/utils";

/**
 * Untrusted Markdown, formatted: a README (ADR-35) and an agent's answer in the conversation view (ADR-107). Ready-made Streamdown (GFM, raw HTML through sanitization, Mermaid diagrams
 * in `strict` mode). Loaded lazily, because Mermaid weighs a few MB. Content from a repo or an agent is untrusted, so nothing in it
 * navigates the window: the container catches every click on a link, also in a diagram's SVG, the daemon opens a web page
 * address in the system browser, and the rest is text. Images are replaced by their description.
 */
const plugins = { mermaid: createMermaidPlugin({ config: { theme: "dark" } }) };
/**
 * Our own plugins instead of Streamdown's defaults: sanitization with GitHub's schema with the `user-content-` prefix for
 * `id` and `name` (Streamdown strips it, and the text could then overwrite named elements of the window) and without
 * `rehype-harden`, which without a base URL turns relative links and images into "[blocked]". `metastring` is the code
 * block options Streamdown carries over from the fence (for example `startLine=10`).
 */
const schema = {
  ...defaultSchema,
  attributes: { ...defaultSchema.attributes, code: [...(defaultSchema.attributes?.code ?? []), "metastring"] },
};
/** Raw HTML only where a format has it (a README); in an agent's answer an HTML tag stays out, sanitized either way. */
const withHtml: ComponentProps<typeof Streamdown>["rehypePlugins"] = [rehypeRaw, [rehypeSanitize, schema]];
const withoutHtml: ComponentProps<typeof Streamdown>["rehypePlugins"] = [[rehypeSanitize, schema]];
const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
};
const components = { a: Link, img: Image };
const mermaid = { errorComponent: MermaidError };
/** The middle mouse button: the browser would open the link in a new WebView window instead of the system browser. */
const MIDDLE_BUTTON = 1;

/**
 * `html` lets raw HTML in, sanitized, as GitHub shows a README. `streaming` for text that is still growing (an answer chunk by chunk): Streamdown then closes an unfinished code block
 * or emphasis instead of showing its marks.
 */
export function Markdown({
  conn,
  text,
  html,
  streaming = false,
  className,
}: {
  conn: Connection;
  text: string;
  html: boolean;
  streaming?: boolean;
  className?: string;
}) {
  const openLink = useOpenWebLink(conn);
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
    openLink(url.data).catch((err: unknown) => setLinkError(errorMessage(err)));
  };

  return (
    <div
      className={cn("flex flex-col gap-3 text-sm leading-relaxed", className)}
      onClickCapture={followLink}
      onAuxClickCapture={followLink}
    >
      {linkError && <p className="text-destructive text-xs">Could not open the link: {linkError}</p>}
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        plugins={plugins}
        rehypePlugins={html ? withHtml : withoutHtml}
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
