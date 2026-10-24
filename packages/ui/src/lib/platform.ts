/** WKWebView i Safari podają `Macintosh` w user agencie, WebView2 na Windowsie nie. */
export const IS_MAC = navigator.userAgent.includes("Mac");

/** The system app that shows folders, as its button names it (ADR-51). */
export function fileManagerName(userAgent: string): string {
  if (userAgent.includes("Windows")) return "Explorer";
  if (userAgent.includes("Mac")) return "Finder";
  return "the file manager";
}
