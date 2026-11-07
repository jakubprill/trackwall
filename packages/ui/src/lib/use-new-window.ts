import { useMemo, useState } from "react";
import { inDesktopShell, openWindow, showViewMenu } from "./app-window.ts";

/**
 * Opening a view in a new window of the desktop app (ADR-49), from a shortcut, the view bar's menu or the menu bar, with
 * the error to show when the shell could not; `newWindow` is `undefined` in a browser tab, which has no extra windows.
 */
export function useNewWindow<View extends string>() {
  const [windowError, setWindowError] = useState<string>();
  const newWindow = useMemo(() => {
    if (!inDesktopShell()) return undefined;
    const open = (id: View) => {
      setWindowError(undefined);
      openWindow(id).catch((err: unknown) => setWindowError(`Could not open a new window: ${String(err)}`));
    };
    const showMenu = (id: View) => {
      showViewMenu(() => open(id)).catch((err: unknown) => setWindowError(`Could not show the menu: ${String(err)}`));
    };
    return { open, showMenu };
  }, []);
  return { newWindow, windowError, dismissWindowError: () => setWindowError(undefined) };
}
