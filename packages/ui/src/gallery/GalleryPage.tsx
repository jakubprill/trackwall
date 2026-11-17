import { cn } from "@/lib/utils";
import type { GallerySection } from "./gallery-state.ts";

const THEMES = ["dark", "light"] as const;
const FONTS = [
  { id: "system", label: "browser font", className: "" },
  { id: "wide", label: "wider font (Segoe UI width)", className: "gallery-wide-font" },
] as const;

/**
 * The gallery of view states: every part of a view in `sections`, in every state, drawn by the app's own components
 * from sample data, in both themes and with a wider font. A person looks through it for anything out of place; the E2E
 * test `view-states.e2e.ts` checks every frame for text out of its frame, text over text and marks under other things.
 */
export function GalleryPage({ sections }: { sections: readonly GallerySection[] }) {
  return (
    <main className="flex flex-col gap-10 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-medium">Trackwall view states</h1>
        <p className="text-muted-foreground max-w-3xl text-sm">
          Every state of each part of a view, drawn by the app's own components from sample data, in the dark and light theme, with the
          browser's font and with a wider one that stands in for Segoe UI. Nothing here talks to a daemon.
        </p>
        <nav aria-label="Sections" className="flex flex-wrap gap-x-4 text-sm">
          {sections.map((section) => (
            <a key={section.name} href={`#${anchor(section.name)}`} className="text-primary hover:underline">
              {section.name}
            </a>
          ))}
        </nav>
      </header>
      {sections.map((section) => (
        <section key={section.name} id={anchor(section.name)} className="flex flex-col gap-6">
          <h2 className="hud-label">{section.name}</h2>
          {section.states.map((state) => (
            <div key={state.name} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">{state.name}</h3>
              <div className="flex flex-wrap items-start gap-4">
                {section.sizes.flatMap((size) =>
                  THEMES.flatMap((theme) =>
                    FONTS.map((font) => {
                      const caption = `${section.sizes.length > 1 ? `${size.name} · ` : ""}${theme} · ${font.label}`;
                      return (
                        <figure
                          key={`${size.name}-${theme}-${font.id}`}
                          data-gallery-frame={`${section.name} · ${state.name} · ${caption}`}
                          className="flex flex-col gap-1"
                        >
                          <figcaption className="text-muted-foreground font-mono text-2xs">{caption}</figcaption>
                          <div
                            data-theme={theme}
                            data-gallery-content
                            className={cn("bg-background text-foreground flex flex-col rounded-md border", size.className, font.className)}
                          >
                            {state.render()}
                          </div>
                        </figure>
                      );
                    }),
                  ),
                )}
              </div>
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}

function anchor(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
