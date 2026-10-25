import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useRef } from "react";
import { z } from "zod";

/**
 * A click in the menu bar of macOS (ADR-49): the shell sends it to the last focused window as `APP_MENU_EVENT`, and
 * the window shows the view or opens its current view in a new window. The name and the shape are also in
 * `apps/desktop/src-tauri/src/app_menu.rs`; the view is checked by the caller against its own views.
 */
const APP_MENU_EVENT = "app-menu";

const MenuCommand = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("view"), view: z.string() }),
  z.object({ kind: z.literal("new-window") }),
]);
export type MenuCommand = z.infer<typeof MenuCommand>;

/** Calls `onCommand` for a click in the menu bar meant for this window; does nothing outside the Tauri window. */
export function useAppMenu(onCommand: (command: MenuCommand) => void): void {
  const handler = useRef(onCommand);
  handler.current = onCommand;
  useEffect(() => {
    if (!isTauri()) return;
    // This window's own listener: a global `listen` also gets events the shell sends to another window.
    const unlisten = getCurrentWebviewWindow().listen(APP_MENU_EVENT, (event) => {
      const command = MenuCommand.safeParse(event.payload);
      if (command.success) handler.current(command.data);
    });
    return () => {
      void unlisten.then((stop) => stop()).catch(() => undefined);
    };
  }, []);
}
