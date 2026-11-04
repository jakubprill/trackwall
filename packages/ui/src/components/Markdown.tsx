import { createMermaidPlugin } from "@streamdown/mermaid";
import { ExternalLink } from "@trackwall/protocol";
import { ImageOff } from "lucide-react";
import { type ComponentProps, type MouseEvent, useState } from "react";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { Streamdown } from "streamdown";
import { errorMessage } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useOpenWebLink } from "@/lib/desktop";
import { MARKDOWN_REMARK_PLUGINS, MARKDOWN_SANITIZE_SCHEMA, markdownLinkAddress } from "@/lib/markdown-links";
import { useOpenTrackwallLink } from "@/lib/trackwall-link";
import { cn } from "@/lib/utils";

/**
 * Untrusted Markdown, formatted with ready-made Streamdown (GFM, sanitized): a README (ADR-35), with raw HTML and Mermaid
 * diagrams in `strict` mode, and an agent's answer in the conversation view (ADR-107), with neither, because a diagram's
 * HTML labels and theme CSS can load addresses and an answer is what a prompt-injected agent writes. Loaded lazily,
 * because Mermaid weighs a few MB. Nothing in the text navigates the window: the container catches every click on a
 * link, also in a diagram's SVG, the daemon opens a web page address in the system browser, a `trackwall://` link
 * switches the view (ADR-52), and the rest is text. Images are replaced by their description.
 */
export type MarkdownSource = "readme" | "agent";
const README_PLUGINS = { mermaid: createMermaidPlugin({ config: { theme: "dark" } }) };
const AGENT_PLUGINS = {};
const README_REHYPE: ComponentProps<typeof Streamdown>["rehypePlugins"] = [rehypeRaw, [rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]];
const AGENT_REHYPE: ComponentProps<typeof Streamdown>["rehypePlugins"] = [[rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]];
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
 * `streaming` for text that is still growing (an answer chunk by chunk): Streamdown then closes an unfinished code block
 * or emphasis instead of showing its marks.
 */
export function Markdown({
  conn,
  text,
  source,
  streaming = false,
  className,
}: {
  conn: Connection;
  text: string;
  source: MarkdownSource;
  streaming?: boolean;
  className?: string;
}) {
  const openLink = useOpenWebLink(conn);
  const openTrackwallLink = useOpenTrackwallLink();
  const [linkError, setLinkError] = useState<string>();
  const followLink = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = e.target instanceof Element ? e.target.closest("a") : null;
    if (!anchor) return;
    e.preventDefault();
    if (e.type === "auxclick" && e.button !== MIDDLE_BUTTON) return;
    // A link from a Mermaid diagram is an `<a>` in SVG, often with `xlink:href`.
    const href = anchor.getAttribute("href") ?? anchor.getAttribute("xlink:href");
    if (href !== null && openTrackwallLink(href)) return;
    const url = ExternalLink.safeParse(href);
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
        isAnimating={streaming}
        plugins={source === "readme" ? README_PLUGINS : AGENT_PLUGINS}
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={source === "readme" ? README_REHYPE : AGENT_REHYPE}
        controls={controls}
        mermaid={mermaid}
        components={components}
      >
        {text}
      </Streamdown>
    </div>
  );
}

/** A link to a web page or a `trackwall://` link looks like a link; a relative one, an anchor and other protocols stay
 * text with the address in a tooltip. */
function Link({ href, children }: ComponentProps<"a">) {
  const url = markdownLinkAddress(href);
  if (url === undefined) return <span title={href}>{children}</span>;
  return (
    <a href={url} title={url} className="text-primary underline-offset-4 hover:underline">
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
