import { workspaceApi } from "@trackwall/protocol";
import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import {
  isPaletteShortcut,
  matchCommands,
  type PaletteAction,
  type PaletteCommand,
  paletteCommands,
  paletteShortcutLabel,
} from "@/lib/command-palette";
import type { Connection } from "@/lib/connection";
import { optionAfterKey } from "@/lib/dialog-keyboard";
import { IS_MAC } from "@/lib/platform";
import type { SessionEntry } from "@/lib/session-entries";
import { useTheme } from "@/lib/theme-controller";
import { useRemote } from "@/lib/use-remote";
import { useWindowShortcuts } from "@/lib/use-window-shortcuts";
import type { ViewShortcut } from "@/lib/view-shortcut";

/** The class xterm.js gives a terminal's root element; a key pressed inside it is the terminal's (ADR-246). */
const TERMINAL_CLASS = "xterm";

function inTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`.${TERMINAL_CLASS}`) !== null;
}

/**
 * The command palette (ADR-246, `lib/command-palette.ts`): Ctrl+K (⌘K) over any view, Ctrl+Shift+K from a terminal. It
 * changes the theme itself and hands every other command to `onRun`, which knows the views. Esc or a click outside closes
 * it and gives the keyboard back where it was; a command leaves the keyboard where the command puts it.
 */
export function CommandPalette<ViewId extends string>({
  conn,
  views,
  entries,
  newWindow,
  onRun,
}: {
  conn: Connection | undefined;
  views: readonly { id: ViewId; label: string; shortcut: ViewShortcut }[];
  entries: readonly SessionEntry[];
  newWindow: boolean;
  onRun: (action: Exclude<PaletteAction<ViewId>, { kind: "theme" }>) => void;
}) {
  const [open, setOpen] = useState(false);
  // While open, the palette's own field has the keyboard, and the same key closes it there (`PaletteWindow`).
  useWindowShortcuts(
    (event) => (!open && isPaletteShortcut(event, { isMac: IS_MAC, inTerminal: inTerminal(event.target) }) ? true : undefined),
    () => {
      setOpen(true);
      return true;
    },
  );
  if (!open) return null;
  return <PaletteWindow conn={conn} views={views} entries={entries} newWindow={newWindow} onRun={onRun} onClose={() => setOpen(false)} />;
}

function PaletteWindow<ViewId extends string>({
  conn,
  views,
  entries,
  newWindow,
  onRun,
  onClose,
}: Parameters<typeof CommandPalette<ViewId>>[0] & { onClose: () => void }) {
  const { choice, choose } = useTheme();
  // The quick repo list, without git (ADR-113), loaded each time the palette opens: it names the repos and nothing more.
  const loadRepos = useMemo(() => conn && (() => post(conn, workspaceApi.entries, {})), [conn]);
  const repos = useRemote(loadRepos).data?.repos;
  const commands = useMemo(
    () =>
      paletteCommands({
        views,
        entries,
        repos: repos?.map((r) => r.id) ?? [],
        theme: choice,
        newWindow,
        isMac: IS_MAC,
      }),
    [views, entries, repos, choice, newWindow],
  );
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const shown = useMemo(() => matchCommands(commands, query), [commands, query]);
  const current = Math.min(active, shown.length - 1);
  const back = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const dismiss = () => {
    onClose();
    back.current?.focus();
  };
  const run = (command: PaletteCommand<ViewId> | undefined) => {
    if (!command) return;
    onClose();
    const { action } = command;
    if (action.kind === "theme") choose(action.choice);
    else onRun(action);
  };
  // Esc, Enter and the palette's key are the palette's alone: a view's own Esc must not act on them as well.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const closes = e.key === "Escape" || isPaletteShortcut(e, { isMac: IS_MAC, inTerminal: false });
    if (closes || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (closes) dismiss();
      else run(shown[current]);
      return;
    }
    // Home and End move the caret in the field, so only the arrows move through the list.
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const next = optionAfterKey(e.key, current, shown.length);
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  return (
    // A click on the dimmed page closes the palette, as Esc does.
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is not a control; Esc closes the palette from the keyboard.
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above, Esc is the keyboard's way out.
    <div className="bg-background/60 fixed inset-0 z-50 flex justify-center pt-24" onClick={dismiss}>
      <div
        role="dialog"
        aria-label="Command palette"
        className="bg-overlay flex h-fit max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-md border shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <Input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={shown[current] ? optionId(shown[current]) : undefined}
            aria-label="Go to or do"
            placeholder="Go to a session, task, repo, view or setting…"
            value={query}
            onFocus={(e) => {
              back.current = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="dark:bg-transparent h-11 flex-1 border-0 px-0 shadow-none focus-visible:ring-0"
          />
          <kbd className="text-muted-foreground font-mono text-2xs">{paletteShortcutLabel(IS_MAC)}</kbd>
        </div>
        <div ref={list} id="command-palette-list" role="listbox" aria-label="Commands" className="overflow-y-auto p-1">
          {shown.map((command, index) => (
            <div
              key={command.id}
              id={optionId(command)}
              role="option"
              aria-selected={index === current}
              tabIndex={-1}
              onMouseMove={() => setActive(index)}
              onMouseDown={(e) => {
                // The field keeps the keyboard while the pointer picks a command.
                e.preventDefault();
                run(command);
              }}
              className="aria-selected:bg-accent aria-selected:text-accent-foreground flex cursor-pointer items-center gap-3 rounded-sm px-2 py-1.5 text-sm"
            >
              <span className="text-muted-foreground w-16 shrink-0 font-mono text-2xs uppercase">{command.group}</span>
              <span className="min-w-0 flex-1 truncate">
                {command.label}
                {command.detail && <span className="text-muted-foreground ml-2">{command.detail}</span>}
              </span>
              {command.shortcut && <kbd className="text-muted-foreground shrink-0 font-mono text-2xs">{command.shortcut}</kbd>}
            </div>
          ))}
          {shown.length === 0 && <p className="text-muted-foreground px-2 py-3 text-sm">Nothing matches "{query}".</p>}
        </div>
      </div>
    </div>
  );
}

function optionId(command: PaletteCommand<string>): string {
  return `command-palette-${command.id}`;
}
