import { invoke, isTauri } from "@tauri-apps/api/core";
import { type RefObject, useContext, useEffect, useRef } from "react";
import { uploadDrop } from "./api.ts";
import type { Connection } from "./connection.ts";
import { DaemonPlaceContext } from "./desktop.ts";
import { carriesFiles, type DropSource, droppedFileName, READ_COMMAND, sendDropped } from "./dropped-files.ts";
import { DROP_HOVER, FileDropEvent } from "./file-drop.ts";

interface TerminalDrop {
  /** Whether the terminal's program still runs and takes the paths. */
  live: () => boolean;
  paste: (paths: readonly string[]) => void;
  /** A line above the terminal, or `undefined` to clear it. */
  notify: (notice: string | undefined) => void;
}

/**
 * Files dropped on a terminal's frame. With the daemon on this desktop the terminal gets their paths (ADR-51); with a
 * daemon elsewhere, and always in a browser, which gives the page no paths, it gets the paths of the copies the daemon
 * kept (ADR-196, `dropped-files.ts`). The desktop app's drops come as a `FileDropEvent` (`use-file-drop.ts`); a
 * browser's as the page's own drag events.
 */
export function useTerminalDrop(frame: RefObject<HTMLElement | null>, conn: Connection, drop: TerminalDrop): void {
  const handlers = useRef(drop);
  handlers.current = drop;
  const desktop = useContext(DaemonPlaceContext).desktop;
  const local = useRef(desktop);
  local.current = desktop;

  useEffect(() => {
    const target = frame.current;
    if (!target) return;
    const ended = () => {
      if (handlers.current.live()) return false;
      handlers.current.notify("The terminal's program has ended, so nothing was pasted.");
      return true;
    };
    const send = (sources: DropSource[]) => {
      if (ended()) return;
      const { notify } = handlers.current;
      notify(sources.length === 1 ? `Copying ${sources[0]?.name} to the daemon…` : `Copying ${sources.length} files to the daemon…`);
      sendDropped(sources, (name, body) => uploadDrop(conn, name, body)).then(
        (paths) => {
          notify(undefined);
          if (!ended()) handlers.current.paste(paths);
        },
        (err: unknown) => notify(`The dropped files were not copied: ${err instanceof Error ? err.message : String(err)}`),
      );
    };
    const fromShell = (event: Event) => {
      if (!(event instanceof FileDropEvent)) return;
      if (!local.current)
        return send(event.paths.map((path) => ({ name: droppedFileName(path), read: () => invoke<ArrayBuffer>(READ_COMMAND, { path }) })));
      if (!ended()) handlers.current.paste(event.paths);
    };
    target.addEventListener(FileDropEvent.type, fromShell);
    if (isTauri()) return () => target.removeEventListener(FileDropEvent.type, fromShell);

    const over = (event: DragEvent) => {
      if (!event.dataTransfer || !carriesFiles([...event.dataTransfer.types])) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      target.setAttribute(DROP_HOVER, "");
    };
    const leave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) target.removeAttribute(DROP_HOVER);
    };
    const fromBrowser = (event: DragEvent) => {
      target.removeAttribute(DROP_HOVER);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      send(files.map((file) => ({ name: file.name, size: file.size, read: async () => file })));
    };
    target.addEventListener("dragover", over);
    target.addEventListener("dragleave", leave);
    target.addEventListener("drop", fromBrowser);
    return () => {
      target.removeEventListener(FileDropEvent.type, fromShell);
      target.removeEventListener("dragover", over);
      target.removeEventListener("dragleave", leave);
      target.removeEventListener("drop", fromBrowser);
    };
  }, [frame, conn]);
}
