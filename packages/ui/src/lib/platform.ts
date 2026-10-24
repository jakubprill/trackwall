/** WKWebView i Safari podają `Macintosh` w user agencie, WebView2 na Windowsie nie. */
export const IS_MAC = navigator.userAgent.includes("Mac");
