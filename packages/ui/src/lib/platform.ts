/** The system from the user agent: WKWebView and Safari say `Macintosh`, WebView2 says `Windows`. */
export function systemOf(userAgent: string): "windows" | "mac" | "other" {
  if (userAgent.includes("Windows")) return "windows";
  if (userAgent.includes("Mac")) return "mac";
  return "other";
}

const SYSTEM = systemOf(navigator.userAgent);

export const IS_MAC = SYSTEM === "mac";

/** The system app that shows folders, as its button names it (ADR-51). */
export const FILE_MANAGER = { windows: "Explorer", mac: "Finder", other: "the file manager" }[SYSTEM];
