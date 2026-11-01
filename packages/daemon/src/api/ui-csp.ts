/**
 * The Content-Security-Policy of the UI in a browser tab (ADR-161): the Tauri window's own policy, so that a README's
 * Mermaid label or any other content from a repo is held to the same rules in both (§8), adjusted for a tab.
 * `apps/desktop/test` cannot import the daemon, so `test/ui-csp.test.ts` keeps `WINDOW_CSP` equal to `app.security.csp`
 * in `tauri.conf.json`; change both together.
 */

/** `app.security.csp` of `apps/desktop/src-tauri/tauri.conf.json`. */
export const WINDOW_CSP =
  "default-src 'self' ipc: http://ipc.localhost; connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data:; style-src 'self' 'unsafe-inline'";

/** Tauri's IPC, which in a browser would mean any server on loopback port 80, a source for scripts and frames too. */
const TAURI_IPC_SOURCES = / (?:ipc:|http:\/\/ipc\.localhost)(?=[ ;]|$)/g;

/**
 * What only a tab needs: any page the browser visits could put it in a frame and trick a click on an approval
 * (`frame-ancestors` works only as a header, which is why the window's policy does not carry it), and `base-uri` and
 * `form-action` do not fall back to `default-src`, so HTML from a repo could otherwise move links or send a form outside.
 */
const TAB_ONLY = "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const TAB_CSP = `${WINDOW_CSP.replace(TAURI_IPC_SOURCES, "")}; ${TAB_ONLY}`;
