/**
 * The Content-Security-Policy of the UI in a browser tab (ADR-161): the Tauri window's own policy, so that a README's
 * Mermaid label or any other content from a repo is held to the same rules in both (§8), plus what only a tab needs.
 * `apps/desktop/test` cannot import the daemon, so `test/ui-csp.test.ts` keeps `WINDOW_CSP` equal to `app.security.csp`
 * in `tauri.conf.json`; change both together.
 */

/** `app.security.csp` of `apps/desktop/src-tauri/tauri.conf.json`. */
export const WINDOW_CSP =
  "default-src 'self' ipc: http://ipc.localhost; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

/**
 * A tab, unlike the window, can be put in a frame by any page the browser visits, which could then trick a click on
 * an approval; `frame-ancestors` works only as a header, which is why the window's policy does not carry it.
 */
export const TAB_CSP = `${WINDOW_CSP}; frame-ancestors 'none'`;
