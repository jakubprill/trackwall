import { createMermaidPlugin } from "@streamdown/mermaid";
import { ExternalLink, workspaceApi } from "@trackwall/protocol";
import { ImageOff } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { defaultRehypePlugins, Streamdown } from "streamdown";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";

/**
 * README jako sformatowany Markdown (ADR-35): gotowy Streamdown (GFM, surowy HTML przez sanityzację, diagramy Mermaid
 * w trybie `strict`). Ładowany leniwie, bo Mermaid waży kilka MB. Treść z repo jest niezaufana, więc nic z niej nie
 * nawiguje oknem: link na stronę albo pocztę otwiera daemon w systemie, inne linki są tekstem, a obrazy zastępuje
 * ich opis, bo okno i tak wpuszcza tylko obrazy z `self` i `data:`.
 */
const plugins = { mermaid: createMermaidPlugin({ config: { theme: "dark" } }) };
/**
 * Domyślne wtyczki bez `rehype-harden`: bez adresu bazowego zamienia linki i obrazy względne w „[blocked]”, a to, co
 * chroni, robią tu sanityzacja (bez `javascript:` i skryptów) i własne `a` oraz `img` niżej.
 */
const rehypePlugins = [defaultRehypePlugins.raw, defaultRehypePlugins.sanitize].filter((p) => p !== undefined);
const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: true },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
  image: false,
};

export function ReadmeMarkdown({ conn, text }: { conn: Connection; text: string }) {
  const [linkError, setLinkError] = useState<string>();
  const openLink = (url: string) => {
    setLinkError(undefined);
    post(conn, workspaceApi.openLink, { url }).catch((err: unknown) => setLinkError(errorMessage(err)));
  };

  return (
    <div className="flex flex-col gap-3 p-4 text-sm leading-relaxed">
      {linkError && <p className="text-destructive text-xs">Could not open the link: {linkError}</p>}
      <Streamdown
        mode="static"
        plugins={plugins}
        rehypePlugins={rehypePlugins}
        controls={controls}
        mermaid={{ errorComponent: MermaidError }}
        components={{ a: (props) => <Link {...props} onOpen={openLink} />, img: (props) => <Image {...props} /> }}
      >
        {text}
      </Streamdown>
    </div>
  );
}

function Link({ href, children, onOpen }: ComponentProps<"a"> & { onOpen: (url: string) => void }) {
  const url = ExternalLink.safeParse(href);
  if (!url.success) return <span title={href}>{children}</span>;
  return (
    <a
      href={url.data}
      title={url.data}
      className="text-primary underline-offset-4 hover:underline"
      onClick={(e) => {
        e.preventDefault();
        onOpen(url.data);
      }}
    >
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
