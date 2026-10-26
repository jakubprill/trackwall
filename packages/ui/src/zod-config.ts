import { z } from "zod";

/**
 * zod probes with `Function("")` whether it may compile its parsers, at the first object schema it builds. The Tauri
 * window's CSP refuses code from strings, so the probe fails (zod then parses without compiling) but leaves a CSP violation
 * in the console of every window, among which a real one would go unnoticed. `jitless` skips the probe. It has to be set
 * before any schema is built, which `@trackwall/protocol` does on import: `main.tsx` imports this module first, and
 * `vite.config.ts` puts it in zod's own chunk, which runs before the chunks with schemas that import it.
 */
z.config({ jitless: true });
