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
 * README jako sformatowany Markdown (ADR-35): gotowy Streamdown (GFM, surowy HTML przez sanityzację, diagramy Mermaid
 * w trybie `strict`). Ładowany leniwie, bo Mermaid waży kilka MB. Treść z repo jest niezaufana, więc nic z niej nie
 * nawiguje oknem: każdy klik w link, także w SVG diagramu, łapie kontener, adres strony otwiera daemon w przeglądarce
 * systemu, a reszta jest tekstem. Obrazy zastępuje ich opis.
 */
const plugins = { mermaid: createMermaidPlugin({ config: { theme: "dark" } }) };
/**
 * Własne wtyczki zamiast domyślnych Streamdown: sanityzacja ze schematem GitHuba z prefiksem `user-content-` dla `id`
 * i `name` (Streamdown go zdejmuje, a README mógłby wtedy nadpisać nazwane elementy okna) i bez `rehype-harden`,
 * który bez adresu bazowego zamienia linki i obrazy względne w „[blocked]”.
 */
const rehypePlugins: ComponentProps<typeof Streamdown>["rehypePlugins"] = [rehypeRaw, [rehypeSanitize, defaultSchema]];
const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
};
const components = { a: Link, img: Image };
const mermaid = { errorComponent: MermaidError };
/** Środkowy przycisk myszy: przeglądarka otworzyłaby link w nowym oknie WebView zamiast w przeglądarce systemu. */
const MIDDLE_BUTTON = 1;

export function ReadmeMarkdown({ conn, text }: { conn: Connection; text: string }) {
  const [linkError, setLinkError] = useState<string>();
  const followLink = (e: MouseEvent<HTMLDivElement>) => {
    const anchor = e.target instanceof Element ? e.target.closest("a") : null;
    if (!anchor) return;
    e.preventDefault();
    if (e.type === "auxclick" && e.button !== MIDDLE_BUTTON) return;
    // Link z diagramu Mermaid to `<a>` w SVG, często z `xlink:href`.
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

/** Link na stronę wygląda jak link; względny, kotwica i inne protokoły zostają tekstem z adresem w podpowiedzi. */
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
